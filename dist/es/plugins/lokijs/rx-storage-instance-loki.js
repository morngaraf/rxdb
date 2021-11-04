import _asyncToGenerator from "@babel/runtime/helpers/asyncToGenerator";
import _regeneratorRuntime from "@babel/runtime/regenerator";
import lokijs from 'lokijs';
import { Subject } from 'rxjs';
import { promiseWait, createRevision, getHeightOfRevision, parseRevision, lastOfArray, flatClone, now, ensureNotFalsy, randomCouchString } from '../../util';
import { newRxError } from '../../rx-error';
import { getPrimaryFieldOfPrimaryKey } from '../../rx-schema';
import { LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE, CHANGES_COLLECTION_SUFFIX, closeLokiCollections, getLokiDatabase, getLokiEventKey, OPEN_LOKIJS_STORAGE_INSTANCES, LOKIJS_COLLECTION_DEFAULT_OPTIONS } from './lokijs-helper';
import { getLeaderElectorByBroadcastChannel } from '../leader-election';
var instanceId = 1;
export var RxStorageInstanceLoki = /*#__PURE__*/function () {
  function RxStorageInstanceLoki(databaseName, collectionName, schema, internals, options, databaseSettings, broadcastChannel) {
    var _this = this;

    this.changes$ = new Subject();
    this.lastChangefeedSequence = 0;
    this.instanceId = instanceId++;
    this.databaseName = databaseName;
    this.collectionName = collectionName;
    this.schema = schema;
    this.internals = internals;
    this.options = options;
    this.databaseSettings = databaseSettings;
    this.broadcastChannel = broadcastChannel;
    this.primaryPath = getPrimaryFieldOfPrimaryKey(this.schema.primaryKey);
    OPEN_LOKIJS_STORAGE_INSTANCES.add(this);

    if (broadcastChannel) {
      this.leaderElector = getLeaderElectorByBroadcastChannel(broadcastChannel);
      this.leaderElector.awaitLeadership().then(function () {
        // this instance is leader now, so it has to reply to queries from other instances
        ensureNotFalsy(_this.broadcastChannel).addEventListener('message', /*#__PURE__*/function () {
          var _ref = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee(msg) {
            var operation, params, result, isError, _ref2, response;

            return _regeneratorRuntime.wrap(function _callee$(_context) {
              while (1) {
                switch (_context.prev = _context.next) {
                  case 0:
                    if (!(msg.type === LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE && msg.requestId && msg.databaseName === _this.databaseName && msg.collectionName === _this.collectionName && !msg.response)) {
                      _context.next = 16;
                      break;
                    }

                    operation = msg.operation;
                    params = msg.params;
                    isError = false;
                    _context.prev = 4;
                    _context.next = 7;
                    return (_ref2 = _this)[operation].apply(_ref2, params);

                  case 7:
                    result = _context.sent;
                    _context.next = 14;
                    break;

                  case 10:
                    _context.prev = 10;
                    _context.t0 = _context["catch"](4);
                    result = _context.t0;
                    isError = true;

                  case 14:
                    response = {
                      response: true,
                      requestId: msg.requestId,
                      databaseName: _this.databaseName,
                      collectionName: _this.collectionName,
                      result: result,
                      isError: isError,
                      type: msg.type
                    };
                    ensureNotFalsy(_this.broadcastChannel).postMessage(response);

                  case 16:
                  case "end":
                    return _context.stop();
                }
              }
            }, _callee, null, [[4, 10]]);
          }));

          return function (_x) {
            return _ref.apply(this, arguments);
          };
        }());
      });
    }
  }

  var _proto = RxStorageInstanceLoki.prototype;

  _proto.getLocalState = function getLocalState() {
    var ret = ensureNotFalsy(this.internals.localState);
    return ret;
  }
  /**
   * If the local state must be used, that one is returned.
   * Returns false if a remote instance must be used.
   */
  ;

  _proto.mustUseLocalState =
  /*#__PURE__*/
  function () {
    var _mustUseLocalState = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee2() {
      var leaderElector;
      return _regeneratorRuntime.wrap(function _callee2$(_context2) {
        while (1) {
          switch (_context2.prev = _context2.next) {
            case 0:
              if (!this.internals.localState) {
                _context2.next = 2;
                break;
              }

              return _context2.abrupt("return", this.internals.localState);

            case 2:
              leaderElector = ensureNotFalsy(this.leaderElector);

            case 3:
              if (leaderElector.hasLeader) {
                _context2.next = 10;
                break;
              }

              _context2.next = 6;
              return leaderElector.applyOnce();

            case 6:
              _context2.next = 8;
              return promiseWait(0);

            case 8:
              _context2.next = 3;
              break;

            case 10:
              if (!(leaderElector.isLeader && !this.internals.localState)) {
                _context2.next = 15;
                break;
              }

              // own is leader, use local instance
              this.internals.localState = createLokiLocalState({
                databaseName: this.databaseName,
                collectionName: this.collectionName,
                options: this.options,
                schema: this.schema,
                broadcastChannel: this.broadcastChannel
              }, this.databaseSettings);
              return _context2.abrupt("return", this.getLocalState());

            case 15:
              return _context2.abrupt("return", false);

            case 16:
            case "end":
              return _context2.stop();
          }
        }
      }, _callee2, this);
    }));

    function mustUseLocalState() {
      return _mustUseLocalState.apply(this, arguments);
    }

    return mustUseLocalState;
  }();

  _proto.requestRemoteInstance = /*#__PURE__*/function () {
    var _requestRemoteInstance = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee3(operation, params) {
      var broadcastChannel, requestId, responsePromise, result;
      return _regeneratorRuntime.wrap(function _callee3$(_context3) {
        while (1) {
          switch (_context3.prev = _context3.next) {
            case 0:
              broadcastChannel = ensureNotFalsy(this.broadcastChannel);
              requestId = randomCouchString(12);
              responsePromise = new Promise(function (res, rej) {
                var listener = function listener(msg) {
                  if (msg.type === LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE && msg.response === true && msg.requestId === requestId) {
                    if (msg.isError) {
                      broadcastChannel.removeEventListener('message', listener);
                      rej(msg.result);
                    } else {
                      broadcastChannel.removeEventListener('message', listener);
                      res(msg.result);
                    }
                  }
                };

                broadcastChannel.addEventListener('message', listener);
              });
              broadcastChannel.postMessage({
                response: false,
                type: LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE,
                operation: operation,
                params: params,
                requestId: requestId,
                databaseName: this.databaseName,
                collectionName: this.collectionName
              });
              _context3.next = 6;
              return responsePromise;

            case 6:
              result = _context3.sent;
              return _context3.abrupt("return", result);

            case 8:
            case "end":
              return _context3.stop();
          }
        }
      }, _callee3, this);
    }));

    function requestRemoteInstance(_x2, _x3) {
      return _requestRemoteInstance.apply(this, arguments);
    }

    return requestRemoteInstance;
  }()
  /**
   * Adds an entry to the changes feed
   * that can be queried to check which documents have been
   * changed since sequence X.
   */
  ;

  _proto.addChangeDocumentMeta =
  /*#__PURE__*/
  function () {
    var _addChangeDocumentMeta = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee4(id) {
      var localState, lastDoc, nextFeedSequence;
      return _regeneratorRuntime.wrap(function _callee4$(_context4) {
        while (1) {
          switch (_context4.prev = _context4.next) {
            case 0:
              _context4.next = 2;
              return this.getLocalState();

            case 2:
              localState = _context4.sent;

              if (!this.lastChangefeedSequence) {
                lastDoc = localState.changesCollection.chain().simplesort('sequence', true).limit(1).data()[0];

                if (lastDoc) {
                  this.lastChangefeedSequence = lastDoc.sequence;
                }
              }

              nextFeedSequence = this.lastChangefeedSequence + 1;
              localState.changesCollection.insert({
                id: id,
                sequence: nextFeedSequence
              });
              this.lastChangefeedSequence = nextFeedSequence;

            case 7:
            case "end":
              return _context4.stop();
          }
        }
      }, _callee4, this);
    }));

    function addChangeDocumentMeta(_x4) {
      return _addChangeDocumentMeta.apply(this, arguments);
    }

    return addChangeDocumentMeta;
  }();

  _proto.prepareQuery = function prepareQuery(mutateableQuery) {
    mutateableQuery.selector = {
      $and: [{
        _deleted: false
      }, mutateableQuery.selector]
    };
    return mutateableQuery;
  };

  _proto.getSortComparator = function getSortComparator(query) {
    var _ref3;

    // TODO if no sort is given, use sort by primary.
    // This should be done inside of RxDB and not in the storage implementations.
    var sortOptions = query.sort ? query.sort : [(_ref3 = {}, _ref3[this.primaryPath] = 'asc', _ref3)];

    var fun = function fun(a, b) {
      var compareResult = 0; // 1 | -1

      sortOptions.find(function (sortPart) {
        var fieldName = Object.keys(sortPart)[0];
        var direction = Object.values(sortPart)[0];
        var directionMultiplier = direction === 'asc' ? 1 : -1;
        var valueA = a[fieldName];
        var valueB = b[fieldName];

        if (valueA === valueB) {
          return false;
        } else {
          if (valueA > valueB) {
            compareResult = 1 * directionMultiplier;
            return true;
          } else {
            compareResult = -1 * directionMultiplier;
            return true;
          }
        }
      });

      if (!compareResult) {
        throw new Error('no compareResult');
      }

      return compareResult;
    };

    return fun;
  }
  /**
   * Returns a function that determines if a document matches a query selector.
   * It is important to have the exact same logix as lokijs uses, to be sure
   * that the event-reduce algorithm works correct.
   * But LokisJS does not export such a function, the query logic is deep inside of
   * the Resultset prototype.
   * Because I am lazy, I do not copy paste and maintain that code.
   * Instead we create a fake Resultset and apply the prototype method Resultset.prototype.find(),
   * same with Collection.
   */
  ;

  _proto.getQueryMatcher = function getQueryMatcher(query) {
    var fun = function fun(doc) {
      var fakeCollection = {
        data: [doc],
        binaryIndices: {}
      };
      Object.setPrototypeOf(fakeCollection, lokijs.Collection.prototype);
      var fakeResultSet = {
        collection: fakeCollection
      };
      Object.setPrototypeOf(fakeResultSet, lokijs.Resultset.prototype);
      fakeResultSet.find(query.selector, true);
      var ret = fakeResultSet.filteredrows.length > 0;
      return ret;
    };

    return fun;
  };

  _proto.bulkWrite = /*#__PURE__*/function () {
    var _bulkWrite = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee5(documentWrites) {
      var _this2 = this;

      var localState, collection, ret, startTime;
      return _regeneratorRuntime.wrap(function _callee5$(_context5) {
        while (1) {
          switch (_context5.prev = _context5.next) {
            case 0:
              if (!(documentWrites.length === 0)) {
                _context5.next = 2;
                break;
              }

              throw newRxError('P2', {
                args: {
                  documentWrites: documentWrites
                }
              });

            case 2:
              _context5.next = 4;
              return this.mustUseLocalState();

            case 4:
              localState = _context5.sent;

              if (localState) {
                _context5.next = 7;
                break;
              }

              return _context5.abrupt("return", this.requestRemoteInstance('bulkWrite', [documentWrites]));

            case 7:
              _context5.next = 9;
              return promiseWait(0);

            case 9:
              collection = localState.collection;
              ret = {
                success: new Map(),
                error: new Map()
              };
              startTime = now();
              documentWrites.forEach(function (writeRow) {
                var id = writeRow.document[_this2.primaryPath];
                var documentInDb = collection.by(_this2.primaryPath, id);

                if (!documentInDb) {
                  // insert new document
                  var newRevision = '1-' + createRevision(writeRow.document, true);
                  /**
                   * It is possible to insert already deleted documents,
                   * this can happen on replication.
                   */

                  var insertedIsDeleted = writeRow.document._deleted ? true : false;
                  var writeDoc = Object.assign({}, writeRow.document, {
                    _rev: newRevision,
                    _deleted: insertedIsDeleted,
                    // TODO attachments are currently not working with lokijs
                    _attachments: {}
                  });
                  collection.insert(writeDoc);

                  if (!insertedIsDeleted) {
                    _this2.addChangeDocumentMeta(id);

                    _this2.changes$.next({
                      eventId: getLokiEventKey(false, id, newRevision),
                      documentId: id,
                      change: {
                        doc: writeDoc,
                        id: id,
                        operation: 'INSERT',
                        previous: null
                      },
                      startTime: startTime,
                      endTime: now()
                    });
                  }

                  ret.success.set(id, writeDoc);
                } else {
                  // update existing document
                  var revInDb = documentInDb._rev;

                  if (!writeRow.previous || revInDb !== writeRow.previous._rev) {
                    // conflict error
                    var err = {
                      isError: true,
                      status: 409,
                      documentId: id,
                      writeRow: writeRow
                    };
                    ret.error.set(id, err);
                  } else {
                    var newRevHeight = getHeightOfRevision(revInDb) + 1;

                    var _newRevision = newRevHeight + '-' + createRevision(writeRow.document, true);

                    var _writeDoc = Object.assign({}, documentInDb, writeRow.document, {
                      _rev: _newRevision,
                      // TODO attachments are currently not working with lokijs
                      _attachments: {}
                    });

                    collection.update(_writeDoc);

                    _this2.addChangeDocumentMeta(id);

                    var change = null;

                    if (writeRow.previous._deleted && !_writeDoc._deleted) {
                      change = {
                        id: id,
                        operation: 'INSERT',
                        previous: null,
                        doc: _writeDoc
                      };
                    } else if (!writeRow.previous._deleted && !_writeDoc._deleted) {
                      change = {
                        id: id,
                        operation: 'UPDATE',
                        previous: writeRow.previous,
                        doc: _writeDoc
                      };
                    } else if (!writeRow.previous._deleted && _writeDoc._deleted) {
                      change = {
                        id: id,
                        operation: 'DELETE',
                        previous: writeRow.previous,
                        doc: null
                      };
                    }

                    if (!change) {
                      throw newRxError('SNH', {
                        args: {
                          writeRow: writeRow
                        }
                      });
                    }

                    _this2.changes$.next({
                      eventId: getLokiEventKey(false, id, _newRevision),
                      documentId: id,
                      change: change,
                      startTime: startTime,
                      endTime: now()
                    });

                    ret.success.set(id, _writeDoc);
                  }
                }
              });
              return _context5.abrupt("return", ret);

            case 14:
            case "end":
              return _context5.stop();
          }
        }
      }, _callee5, this);
    }));

    function bulkWrite(_x5) {
      return _bulkWrite.apply(this, arguments);
    }

    return bulkWrite;
  }();

  _proto.bulkAddRevisions = /*#__PURE__*/function () {
    var _bulkAddRevisions = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee6(documents) {
      var _this3 = this;

      var localState, startTime, collection;
      return _regeneratorRuntime.wrap(function _callee6$(_context6) {
        while (1) {
          switch (_context6.prev = _context6.next) {
            case 0:
              if (!(documents.length === 0)) {
                _context6.next = 2;
                break;
              }

              throw newRxError('P3', {
                args: {
                  documents: documents
                }
              });

            case 2:
              _context6.next = 4;
              return this.mustUseLocalState();

            case 4:
              localState = _context6.sent;

              if (localState) {
                _context6.next = 7;
                break;
              }

              return _context6.abrupt("return", this.requestRemoteInstance('bulkAddRevisions', [documents]));

            case 7:
              _context6.next = 9;
              return promiseWait(0);

            case 9:
              startTime = now();
              collection = localState.collection;
              documents.forEach(function (docData) {
                var id = docData[_this3.primaryPath];
                var documentInDb = collection.by(_this3.primaryPath, id);

                if (!documentInDb) {
                  // document not here, so we can directly insert
                  collection.insert(docData);

                  _this3.changes$.next({
                    documentId: id,
                    eventId: getLokiEventKey(false, id, docData._rev),
                    change: {
                      doc: docData,
                      id: id,
                      operation: 'INSERT',
                      previous: null
                    },
                    startTime: startTime,
                    endTime: now()
                  });

                  _this3.addChangeDocumentMeta(id);
                } else {
                  var newWriteRevision = parseRevision(docData._rev);
                  var oldRevision = parseRevision(documentInDb._rev);
                  var mustUpdate = false;

                  if (newWriteRevision.height !== oldRevision.height) {
                    // height not equal, compare base on height
                    if (newWriteRevision.height > oldRevision.height) {
                      mustUpdate = true;
                    }
                  } else if (newWriteRevision.hash > oldRevision.hash) {
                    // equal height but new write has the 'winning' hash
                    mustUpdate = true;
                  }

                  if (mustUpdate) {
                    var storeAtLoki = flatClone(docData);
                    storeAtLoki.$loki = documentInDb.$loki;
                    collection.update(storeAtLoki);
                    var change = null;

                    if (documentInDb._deleted && !docData._deleted) {
                      change = {
                        id: id,
                        operation: 'INSERT',
                        previous: null,
                        doc: docData
                      };
                    } else if (!documentInDb._deleted && !docData._deleted) {
                      change = {
                        id: id,
                        operation: 'UPDATE',
                        previous: documentInDb,
                        doc: docData
                      };
                    } else if (!documentInDb._deleted && docData._deleted) {
                      change = {
                        id: id,
                        operation: 'DELETE',
                        previous: documentInDb,
                        doc: null
                      };
                    } else if (documentInDb._deleted && docData._deleted) {
                      change = null;
                    }

                    if (change) {
                      _this3.changes$.next({
                        documentId: id,
                        eventId: getLokiEventKey(false, id, docData._rev),
                        change: change,
                        startTime: startTime,
                        endTime: now()
                      });

                      _this3.addChangeDocumentMeta(id);
                    }
                  }
                }
              });

            case 12:
            case "end":
              return _context6.stop();
          }
        }
      }, _callee6, this);
    }));

    function bulkAddRevisions(_x6) {
      return _bulkAddRevisions.apply(this, arguments);
    }

    return bulkAddRevisions;
  }();

  _proto.findDocumentsById = /*#__PURE__*/function () {
    var _findDocumentsById = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee7(ids, deleted) {
      var _this4 = this;

      var localState, collection, ret;
      return _regeneratorRuntime.wrap(function _callee7$(_context7) {
        while (1) {
          switch (_context7.prev = _context7.next) {
            case 0:
              _context7.next = 2;
              return this.mustUseLocalState();

            case 2:
              localState = _context7.sent;

              if (localState) {
                _context7.next = 5;
                break;
              }

              return _context7.abrupt("return", this.requestRemoteInstance('findDocumentsById', [ids, deleted]));

            case 5:
              collection = localState.collection;
              ret = new Map();
              ids.forEach(function (id) {
                var documentInDb = collection.by(_this4.primaryPath, id);

                if (documentInDb && (!documentInDb._deleted || deleted)) {
                  ret.set(id, documentInDb);
                }
              });
              return _context7.abrupt("return", ret);

            case 9:
            case "end":
              return _context7.stop();
          }
        }
      }, _callee7, this);
    }));

    function findDocumentsById(_x7, _x8) {
      return _findDocumentsById.apply(this, arguments);
    }

    return findDocumentsById;
  }();

  _proto.query = /*#__PURE__*/function () {
    var _query = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee8(preparedQuery) {
      var localState, query, foundDocuments;
      return _regeneratorRuntime.wrap(function _callee8$(_context8) {
        while (1) {
          switch (_context8.prev = _context8.next) {
            case 0:
              _context8.next = 2;
              return this.mustUseLocalState();

            case 2:
              localState = _context8.sent;

              if (localState) {
                _context8.next = 5;
                break;
              }

              return _context8.abrupt("return", this.requestRemoteInstance('query', [preparedQuery]));

            case 5:
              query = localState.collection.chain().find(preparedQuery.selector);

              if (preparedQuery.limit) {
                query = query.limit(preparedQuery.limit);
              }

              if (preparedQuery.skip) {
                query = query.offset(preparedQuery.skip);
              }

              foundDocuments = query.data();
              return _context8.abrupt("return", {
                documents: foundDocuments
              });

            case 10:
            case "end":
              return _context8.stop();
          }
        }
      }, _callee8, this);
    }));

    function query(_x9) {
      return _query.apply(this, arguments);
    }

    return query;
  }();

  _proto.getAttachmentData = function getAttachmentData(_documentId, _attachmentId) {
    throw new Error('Attachments are not implemented in the lokijs RxStorage. Make a pull request.');
  };

  _proto.getChangedDocuments = /*#__PURE__*/function () {
    var _getChangedDocuments = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee9(options) {
      var _sequence;

      var localState, desc, operator, query, changedDocuments, useForLastSequence, ret;
      return _regeneratorRuntime.wrap(function _callee9$(_context9) {
        while (1) {
          switch (_context9.prev = _context9.next) {
            case 0:
              _context9.next = 2;
              return this.mustUseLocalState();

            case 2:
              localState = _context9.sent;

              if (localState) {
                _context9.next = 5;
                break;
              }

              return _context9.abrupt("return", this.requestRemoteInstance('getChangedDocuments', [options]));

            case 5:
              desc = options.order === 'desc';
              operator = options.order === 'asc' ? '$gte' : '$lte';
              query = localState.changesCollection.chain().find({
                sequence: (_sequence = {}, _sequence[operator] = options.startSequence, _sequence)
              }).simplesort('sequence', !desc);

              if (options.limit) {
                query = query.limit(options.limit);
              }

              changedDocuments = query.data().map(function (result) {
                return {
                  id: result.id,
                  sequence: result.sequence
                };
              });
              useForLastSequence = desc ? lastOfArray(changedDocuments) : changedDocuments[0];
              ret = {
                changedDocuments: changedDocuments,
                lastSequence: useForLastSequence ? useForLastSequence.sequence : options.startSequence
              };
              return _context9.abrupt("return", ret);

            case 13:
            case "end":
              return _context9.stop();
          }
        }
      }, _callee9, this);
    }));

    function getChangedDocuments(_x10) {
      return _getChangedDocuments.apply(this, arguments);
    }

    return getChangedDocuments;
  }();

  _proto.changeStream = function changeStream() {
    return this.changes$.asObservable();
  };

  _proto.close = /*#__PURE__*/function () {
    var _close = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee10() {
      var localState;
      return _regeneratorRuntime.wrap(function _callee10$(_context10) {
        while (1) {
          switch (_context10.prev = _context10.next) {
            case 0:
              this.changes$.complete();
              OPEN_LOKIJS_STORAGE_INSTANCES["delete"](this);

              if (!this.internals.localState) {
                _context10.next = 9;
                break;
              }

              _context10.next = 5;
              return this.getLocalState();

            case 5:
              localState = _context10.sent;
              localState.database.saveDatabase();
              _context10.next = 9;
              return closeLokiCollections(this.databaseName, [localState.collection, localState.changesCollection]);

            case 9:
            case "end":
              return _context10.stop();
          }
        }
      }, _callee10, this);
    }));

    function close() {
      return _close.apply(this, arguments);
    }

    return close;
  }();

  _proto.remove = /*#__PURE__*/function () {
    var _remove = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee11() {
      var localState;
      return _regeneratorRuntime.wrap(function _callee11$(_context11) {
        while (1) {
          switch (_context11.prev = _context11.next) {
            case 0:
              _context11.next = 2;
              return this.mustUseLocalState();

            case 2:
              localState = _context11.sent;

              if (localState) {
                _context11.next = 5;
                break;
              }

              return _context11.abrupt("return", this.requestRemoteInstance('remove', []));

            case 5:
              localState.database.removeCollection(this.collectionName);
              localState.database.removeCollection(localState.changesCollection.name);

            case 7:
            case "end":
              return _context11.stop();
          }
        }
      }, _callee11, this);
    }));

    function remove() {
      return _remove.apply(this, arguments);
    }

    return remove;
  }();

  return RxStorageInstanceLoki;
}();
export function createLokiLocalState(_x11, _x12) {
  return _createLokiLocalState.apply(this, arguments);
}

function _createLokiLocalState() {
  _createLokiLocalState = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee12(params, databaseSettings) {
    var databaseState, indices, primaryKey, collectionOptions, collection, changesCollectionName, changesCollectionOptions, changesCollection;
    return _regeneratorRuntime.wrap(function _callee12$(_context12) {
      while (1) {
        switch (_context12.prev = _context12.next) {
          case 0:
            if (!params.options) {
              params.options = {};
            }

            _context12.next = 3;
            return getLokiDatabase(params.databaseName, databaseSettings);

          case 3:
            databaseState = _context12.sent;

            /**
             * Construct loki indexes from RxJsonSchema indexes.
             * TODO what about compound indexes? Are they possible in lokijs?
             */
            indices = [];

            if (params.schema.indexes) {
              params.schema.indexes.forEach(function (idx) {
                if (!Array.isArray(idx)) {
                  indices.push(idx);
                }
              });
            }
            /**
             * LokiJS has no concept of custom primary key, they use a number-id that is generated.
             * To be able to query fast by primary key, we always add an index to the primary.
             */


            primaryKey = getPrimaryFieldOfPrimaryKey(params.schema.primaryKey);
            indices.push(primaryKey);
            /**
             * TODO disable stuff we do not need from CollectionOptions
             */

            collectionOptions = Object.assign({}, params.options.collection, {
              indices: indices,
              unique: [primaryKey]
            }, LOKIJS_COLLECTION_DEFAULT_OPTIONS);
            collection = databaseState.database.addCollection(params.collectionName, collectionOptions);
            databaseState.openCollections[params.collectionName] = collection;
            changesCollectionName = params.collectionName + CHANGES_COLLECTION_SUFFIX;
            changesCollectionOptions = Object.assign({
              unique: ['eventId'],
              indices: ['sequence']
            }, LOKIJS_COLLECTION_DEFAULT_OPTIONS);
            changesCollection = databaseState.database.addCollection(changesCollectionName, changesCollectionOptions);
            databaseState.openCollections[changesCollectionName] = changesCollection;
            return _context12.abrupt("return", {
              database: databaseState.database,
              collection: collection,
              changesCollection: changesCollection
            });

          case 16:
          case "end":
            return _context12.stop();
        }
      }
    }, _callee12);
  }));
  return _createLokiLocalState.apply(this, arguments);
}

export function createLokiStorageInstance(_x13, _x14) {
  return _createLokiStorageInstance.apply(this, arguments);
}

function _createLokiStorageInstance() {
  _createLokiStorageInstance = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime.mark(function _callee13(params, databaseSettings) {
    var internals, instance;
    return _regeneratorRuntime.wrap(function _callee13$(_context13) {
      while (1) {
        switch (_context13.prev = _context13.next) {
          case 0:
            internals = {}; // optimisation shortcut, directly create db is non multi instance.

            if (params.broadcastChannel) {
              _context13.next = 5;
              break;
            }

            internals.localState = createLokiLocalState(params, databaseSettings);
            _context13.next = 5;
            return internals.localState;

          case 5:
            instance = new RxStorageInstanceLoki(params.databaseName, params.collectionName, params.schema, internals, params.options, databaseSettings, params.broadcastChannel);
            return _context13.abrupt("return", instance);

          case 7:
          case "end":
            return _context13.stop();
        }
      }
    }, _callee13);
  }));
  return _createLokiStorageInstance.apply(this, arguments);
}
//# sourceMappingURL=rx-storage-instance-loki.js.map