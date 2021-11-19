/**
 * The DataMigrator handles the documents from collections with older schemas
 * and transforms/saves them into the newest collection
 */
/**
 * TODO this should be completely rewritten because:
 * - The current implemetation does not use bulkDocs which is much faster
 * - This could have been done in much less code which would be easier to uderstand
 *
 */
import {
    Subject,
    Observable
} from 'rxjs';
import deepEqual from 'fast-deep-equal';
import {
    clone,
    toPromise,
    flatClone,
    getHeightOfRevision,
    createRevision,
    PROMISE_RESOLVE_VOID,
    PROMISE_RESOLVE_FALSE,
    PROMISE_RESOLVE_NULL,
    ensureNotFalsy
} from '../../util';
import {
    createRxSchema
} from '../../rx-schema';
import {
    RxError,
    newRxError
} from '../../rx-error';
import {
    runAsyncPluginHooks,
    runPluginHooks
} from '../../hooks';
import type {
    RxCollection,
    RxDatabase,
    MigrationState,
    NumberFunctionMap,
    OldRxCollection,
    WithAttachmentsData,
    RxJsonSchema,
    RxDocumentData
} from '../../types';
import {
    RxSchema,
    getPreviousVersions
} from '../../rx-schema';
import {
    createCrypter
} from '../../crypter';
import {
    getMigrationStateByDatabase,
    MigrationStateWithCollection
} from './migration-state';
import { map } from 'rxjs/operators';
import {
    countAllUndeleted,
    getBatch,
    getSingleDocument
} from '../../rx-storage-helper';
import { InternalStoreDocumentData } from '../../rx-database';
import {
    _handleFromStorageInstance,
    _handleToStorageInstance
} from '../../rx-collection-helper';
import { IdleQueue } from 'custom-idle-queue';

export class DataMigrator {

    constructor(
        public newestCollection: RxCollection,
        public migrationStrategies: NumberFunctionMap
    ) {
        this.currentSchema = newestCollection.schema;
        this.database = newestCollection.database;
        this.name = newestCollection.name;
    }

    public currentSchema: RxSchema;
    public database: RxDatabase;
    public name: string;


    private _migrated: boolean = false;
    private _migratePromise?: Promise<any>;
    private nonMigratedOldCollections: OldRxCollection[] = [];
    private allOldCollections: OldRxCollection[] = [];
    migrate(batchSize: number = 10): Observable<MigrationState> {
        if (this._migrated) {
            throw newRxError('DM1');
        }
        this._migrated = true;

        const state = {
            done: false, // true if finished
            total: 0, // will be the doc-count
            handled: 0, // amount of handled docs
            success: 0, // handled docs which successed
            deleted: 0, // handled docs which got deleted
            percent: 0 // percentage
        };

        const stateSubject: Subject<MigrationStateWithCollection> = new Subject();

        /**
         * Add to output of RxDatabase.migrationStates
         */
        const allSubject = getMigrationStateByDatabase(this.newestCollection.database);
        const allList = allSubject.getValue().slice(0);
        allList.push(stateSubject.asObservable());
        allSubject.next(allList);

        /**
         * TODO this is a side-effect which might throw
         * We did this because it is not possible to create new Observer(async(...))
         * @link https://github.com/ReactiveX/rxjs/issues/4074
         * In the future the whole migration plugin should be rewritten without rxjs
         * so we do not have this problem.
         */
        (() => {
            return _getOldCollections(this)
                .then(ret => {
                    this.nonMigratedOldCollections = ret;
                    this.allOldCollections = this.nonMigratedOldCollections.slice(0);
                    const countAll: Promise<number[]> = Promise.all(
                        this.nonMigratedOldCollections.map(oldCol => countAllUndeleted(oldCol.storageInstance))
                    );
                    return countAll;
                })
                .then(countAll => {
                    const totalCount: number = countAll
                        .reduce((cur, prev) => prev = cur + prev, 0);
                    state.total = totalCount;
                    stateSubject.next({
                        collection: this.newestCollection,
                        state: flatClone(state)
                    });
                    let currentCol = this.nonMigratedOldCollections.shift();
                    let currentPromise = PROMISE_RESOLVE_VOID;
                    while (currentCol) {
                        const migrationState$ = migrateOldCollection(
                            currentCol,
                            batchSize
                        );
                        currentPromise = currentPromise.then(() => {
                            return new Promise(res => {
                                const sub = migrationState$.subscribe(
                                    (subState: any) => {
                                        state.handled++;
                                        (state as any)[subState.type] = (state as any)[subState.type] + 1;
                                        state.percent = Math.round(state.handled / state.total * 100);
                                        stateSubject.next({
                                            collection: this.newestCollection,
                                            state: flatClone(state)
                                        });
                                    },
                                    (e: any) => {
                                        sub.unsubscribe();
                                        this.allOldCollections.forEach(c => c.storageInstance.close());
                                        stateSubject.error(e);
                                    }, () => {
                                        if (currentCol) {
                                            currentCol.storageInstance.close();
                                        }
                                        sub.unsubscribe();
                                        res();
                                    });
                            });
                        });
                        currentCol = this.nonMigratedOldCollections.shift();
                    }
                    return currentPromise;
                })
                .then(() => {
                    state.done = true;
                    state.percent = 100;
                    stateSubject.next({
                        collection: this.newestCollection,
                        state: flatClone(state)
                    });
                    stateSubject.complete();
                });
        })();


        return stateSubject.pipe(
            map(withCollection => withCollection.state)
        );
    }

    migratePromise(batchSize: number): Promise<any> {
        if (!this._migratePromise) {
            this._migratePromise = mustMigrate(this)
                .then(must => {
                    if (!must) {
                        return PROMISE_RESOLVE_FALSE;
                    } else {
                        return new Promise((res, rej) => {
                            const state$ = this.migrate(batchSize);
                            (state$ as any).subscribe(null, rej, res);
                            this.allOldCollections.forEach(c => c.storageInstance.close());
                        })
                            .catch(err => {
                                this.allOldCollections.forEach(c => c.storageInstance.close());
                                throw err;
                            });
                    }
                });
        }
        return this._migratePromise;
    }
}

export async function createOldCollection(
    version: number,
    schemaObj: RxJsonSchema<any>,
    dataMigrator: DataMigrator
): Promise<OldRxCollection> {
    const database = dataMigrator.newestCollection.database;
    // try to fill primaryKey when migrating from database created by RxDB 9 and lower to the latest
    if (typeof schemaObj.primaryKey === 'undefined') {
        schemaObj.primaryKey = Object.keys(schemaObj.properties)
            .filter(key => (schemaObj as any).properties[key].primary)
            .shift() as any;
    }
    const schema = createRxSchema(schemaObj, false);

    const storageInstanceCreationParams = {
        databaseName: database.name,
        collectionName: dataMigrator.newestCollection.name,
        schema: schemaObj,
        idleQueue: new IdleQueue(),
        options: dataMigrator.newestCollection.instanceCreationOptions
    };
    runPluginHooks(
        'preCreateRxStorageInstance',
        storageInstanceCreationParams
    );

    const storageInstance = await database.storage.createStorageInstance(
        storageInstanceCreationParams
    );
    const ret: OldRxCollection = {
        version,
        dataMigrator,
        newestCollection: dataMigrator.newestCollection,
        database,
        schema: createRxSchema(schemaObj, false),
        storageInstance,
        _crypter: createCrypter(
            database.password,
            schema
        )
    };

    return ret;
}


export async function getOldCollectionDocs(
    dataMigrator: DataMigrator
): Promise<RxDocumentData<InternalStoreDocumentData>[]> {
    return Promise.all(
        getPreviousVersions(dataMigrator.currentSchema.jsonSchema)
            .map(v => getSingleDocument<InternalStoreDocumentData>(dataMigrator.database.internalStore, dataMigrator.name + '-' + v))
            .map(fun => fun.catch(() => null)) // auto-catch so Promise.all continues
    )
        .then(oldCollectionDocs => (oldCollectionDocs as any).filter((d: any) => !!d));
}

/**
 * get an array with OldCollection-instances from all existing old storage-instances
 */
export async function _getOldCollections(
    dataMigrator: DataMigrator
): Promise<OldRxCollection[]> {
    const oldColDocs = await getOldCollectionDocs(dataMigrator);

    return Promise.all(
        oldColDocs
            .map(colDoc => {
                if (!colDoc) {
                    return null as any;
                }
                return createOldCollection(
                    colDoc.schema.version,
                    colDoc.schema,
                    dataMigrator
                );
            })
            .filter(colDoc => colDoc !== null)
    );
}


/**
 * returns true if a migration is needed
 */
export function mustMigrate(dataMigrator: DataMigrator): Promise<boolean> {
    if (dataMigrator.currentSchema.version === 0) {
        return PROMISE_RESOLVE_FALSE;
    }
    return getOldCollectionDocs(dataMigrator)
        .then(oldColDocs => {
            if (oldColDocs.length === 0) {
                return false;
            } else {
                return true;
            }
        });
}

export function runStrategyIfNotNull(
    oldCollection: OldRxCollection,
    version: number,
    docOrNull: any | null
): Promise<any | null> {
    if (docOrNull === null) {
        return PROMISE_RESOLVE_NULL;
    } else {
        const ret = oldCollection.dataMigrator.migrationStrategies[version](docOrNull, oldCollection);
        const retPromise = toPromise(ret);
        return retPromise;
    }
}

export function getBatchOfOldCollection(
    oldCollection: OldRxCollection,
    batchSize: number
): Promise<any[]> {
    return getBatch(
        oldCollection.storageInstance,
        batchSize
    )
        .then(docs => docs
            .map(doc => {
                doc = flatClone(doc);
                doc = _handleFromStorageInstance(oldCollection as any, doc);
                return doc;
            })
        );
}

/**
 * runs the doc-data through all following migrationStrategies
 * so it will match the newest schema.
 * @throws Error if final doc does not match final schema or migrationStrategy crashes
 * @return final object or null if migrationStrategy deleted it
 */
export function migrateDocumentData(
    oldCollection: OldRxCollection,
    docData: any
): Promise<any | null> {
    /**
     * We cannot deep-clone Blob or Buffer
     * so we just flat clone it here
     * and attach it to the deep cloned document data.
     */
    const attachmentsBefore = flatClone(docData._attachments);
    const mutateableDocData = clone(docData);
    mutateableDocData._attachments = attachmentsBefore;

    let nextVersion = oldCollection.version + 1;

    // run the document throught migrationStrategies
    let currentPromise = Promise.resolve(mutateableDocData);
    while (nextVersion <= oldCollection.newestCollection.schema.version) {
        const version = nextVersion;
        currentPromise = currentPromise.then(docOrNull => runStrategyIfNotNull(
            oldCollection,
            version,
            docOrNull
        ));
        nextVersion++;
    }

    return currentPromise.then(doc => {
        if (doc === null) {
            return PROMISE_RESOLVE_NULL;
        }

        // check final schema
        try {
            oldCollection.newestCollection.schema.validate(doc);
        } catch (err) {
            const asRxError: RxError = err as any;
            throw newRxError('DM2', {
                fromVersion: oldCollection.version,
                toVersion: oldCollection.newestCollection.schema.version,
                originalDoc: docData,
                finalDoc: doc,
                /**
                 * pass down data from parent error,
                 * to make it better understandable what did not work
                 */
                errors: asRxError.parameters.errors,
                schema: asRxError.parameters.schema
            });
        }
        return doc;
    });
}


export function isDocumentDataWithoutRevisionEqual<T>(doc1: T, doc2: T): boolean {
    const doc1NoRev = Object.assign({}, doc1, {
        _attachments: undefined,
        _rev: undefined
    });
    const doc2NoRev = Object.assign({}, doc2, {
        _attachments: undefined,
        _rev: undefined
    });
    return deepEqual(doc1NoRev, doc2NoRev);
}

/**
 * transform documents data and save them to the new collection
 * @return status-action with status and migrated document
 */
export async function _migrateDocuments(
    oldCollection: OldRxCollection,
    documentsData: any[]
): Promise<{ type: string, doc: any }[]> {

    // run hooks that might mutate documentsData
    await Promise.all(
        documentsData.map(docData => runAsyncPluginHooks(
            'preMigrateDocument',
            {
                docData,
                oldCollection
            }
        ))
    );
    // run the migration strategies on each document
    const migratedDocuments: (any | null)[] = await Promise.all(
        documentsData.map(docData => migrateDocumentData(oldCollection, docData))
    );


    const bulkWriteToStorageInput: any[] = [];
    const actions: any[] = [];

    documentsData.forEach((docData, idx) => {
        const migratedDocData: any | null = migratedDocuments[idx];
        const action = {
            res: null as any,
            type: '',
            migrated: migratedDocData,
            doc: docData,
            oldCollection,
            newestCollection: oldCollection.newestCollection
        };
        actions.push(action);

        /**
         * Determiniticly handle the revision
         * so migrating the same data on multiple instances
         * will result in the same output.
         */
        if (isDocumentDataWithoutRevisionEqual(docData, migratedDocData)) {
            /**
             * Data not changed by migration strategies, keep the same revision.
             * This ensures that other replicated instances that did not migrate already
             * will still have the same document.
             */
            migratedDocData._rev = docData._rev;
        } else if (migratedDocData !== null) {
            /**
             * data changed, increase revision height
             * so replicating instances use our new document data
             */
            const newHeight = getHeightOfRevision(docData._rev) + 1;
            const newRevision = newHeight + '-' + createRevision(migratedDocData);
            migratedDocData._rev = newRevision;
        }


        if (migratedDocData) {
            /**
             * save to newest collection
             * notice that this data also contains the attachments data
             */
            const attachmentsBefore = migratedDocData._attachments;
            const saveData: WithAttachmentsData<any> = _handleToStorageInstance(oldCollection.newestCollection, migratedDocData);
            saveData._attachments = attachmentsBefore;
            bulkWriteToStorageInput.push(saveData);
            action.res = saveData;
            action.type = 'success';
        } else {
            /**
             * Migration strategy returned null
             * which means we should not migrate this document,
             * just drop it.
             */
            action.type = 'deleted';
        }
    });


    /**
     * Write the documents to the newest collection.
     * We need to add as revision
     * because we provide the _rev by our own
     * to have deterministic revisions in case the migration
     * runs on multiple nodes which must lead to the equal storage state.
     */
    if (bulkWriteToStorageInput.length) {
        await oldCollection.newestCollection.storageInstance.bulkAddRevisions(bulkWriteToStorageInput);
    }

    // run hooks
    await Promise.all(
        actions.map(action => runAsyncPluginHooks(
            'postMigrateDocument',
            action
        ))
    );

    // remove the documents from the old collection storage instance
    const bulkDeleteInputData = documentsData.map(docData => {
        const writeDeleted = flatClone(docData);
        writeDeleted._deleted = true;
        return {
            previous: _handleToStorageInstance(oldCollection as any, docData),
            document: _handleToStorageInstance(oldCollection as any, writeDeleted)
        };
    });

    if (bulkDeleteInputData.length) {
        await oldCollection.storageInstance.bulkWrite(bulkDeleteInputData);
    }

    return actions;
}


/**
 * deletes this.storageInstance and removes it from the database.collectionsCollection
 */
export function deleteOldCollection(
    oldCollection: OldRxCollection
): Promise<void> {
    return oldCollection.storageInstance.remove()
        .then(
            () => oldCollection.database.removeCollectionDoc(
                oldCollection.dataMigrator.name,
                oldCollection.schema
            )
        );
}

/**
 * runs the migration on all documents and deletes the storage instance afterwards
 */
export function migrateOldCollection(
    oldCollection: OldRxCollection,
    batchSize = 10
): Observable<any> {
    if (oldCollection._migrate) {
        // already running
        throw newRxError('DM3');
    }
    oldCollection._migrate = true;

    const observer = new Subject();

    /**
     * TODO this is a side-effect which might throw
     * @see DataMigrator.migrate()
     */
    (() => {
        let error: any;
        const allBatchesDone = () => {
            // remove this oldCollection
            return deleteOldCollection(oldCollection)
                .then(() => observer.complete());
        };
        const handleOneBatch = () => {
            return getBatchOfOldCollection(oldCollection, batchSize)
                .then(batch => {
                    if (batch.length === 0) {
                        allBatchesDone();
                        return false;
                    } else {
                        return _migrateDocuments(oldCollection, batch)
                            .then((actions: any[]) => actions.forEach(action => observer.next(action)))
                            .catch(e => error = e)
                            .then(() => true);
                    }
                })
                .then(next => {
                    if (!next) {
                        return;
                    }
                    if (error) {
                        observer.error(error);
                    } else {
                        handleOneBatch();
                    }
                });
        };
        handleOneBatch();
    })();

    return observer.asObservable();
}

export function migratePromise(
    oldCollection: OldRxCollection,
    batchSize?: number
): Promise<any> {
    if (!oldCollection._migratePromise) {
        oldCollection._migratePromise = new Promise((res, rej) => {
            const state$ = migrateOldCollection(oldCollection, batchSize);
            (state$ as any).subscribe(null, rej, res);
        });
    }
    return oldCollection._migratePromise;
}
