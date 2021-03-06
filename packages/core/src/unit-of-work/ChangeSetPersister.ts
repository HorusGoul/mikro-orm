import { MetadataStorage } from '../metadata';
import {
  AnyEntity,
  Dictionary,
  EntityData,
  EntityMetadata,
  EntityProperty,
  FilterQuery,
  IPrimaryKey,
} from '../typings';
import { EntityIdentifier } from '../entity';
import { ChangeSet, ChangeSetType } from './ChangeSet';
import { QueryResult, Transaction } from '../connections';
import { Configuration, Utils } from '../utils';
import { IDatabaseDriver } from '../drivers';
import { Hydrator } from '../hydration';
import { OptimisticLockError } from '../errors';

export class ChangeSetPersister {

  constructor(private readonly driver: IDatabaseDriver,
              private readonly metadata: MetadataStorage,
              private readonly hydrator: Hydrator,
              private readonly config: Configuration) { }

  async executeInserts<T extends AnyEntity<T>>(changeSets: ChangeSet<T>[], ctx?: Transaction): Promise<void> {
    changeSets.forEach(changeSet => this.processProperties(changeSet));

    for (const changeSet of changeSets) {
      await this.persistNewEntity(changeSet, ctx);
    }
  }

  async executeUpdates<T extends AnyEntity<T>>(changeSets: ChangeSet<T>[], ctx?: Transaction): Promise<void> {
    changeSets.forEach(changeSet => this.processProperties(changeSet));

    for (const changeSet of changeSets) {
      await this.persistManagedEntity(changeSet, ctx);
    }
  }

  async executeDeletes<T extends AnyEntity<T>>(changeSets: ChangeSet<T>[], ctx?: Transaction): Promise<void> {
    const meta = changeSets[0].entity.__meta!;
    const pk = Utils.getPrimaryKeyHash(meta.primaryKeys);

    if (meta.compositePK) {
      const pks = changeSets.map(cs => cs.entity.__helper!.__primaryKeys);
      await this.driver.nativeDelete(changeSets[0].name, { [pk]: { $in: pks } }, ctx);
    } else {
      const pks = changeSets.map(cs => cs.entity.__helper!.__primaryKey as Dictionary);
      await this.driver.nativeDelete(changeSets[0].name, { [pk]: { $in: pks } }, ctx);
    }
  }

  private processProperties<T extends AnyEntity<T>>(changeSet: ChangeSet<T>): void {
    const meta = this.metadata.find(changeSet.name)!;

    for (const prop of meta.props) {
      this.processProperty(changeSet, prop);
    }
  }

  private async persistNewEntity<T extends AnyEntity<T>>(changeSet: ChangeSet<T>, ctx?: Transaction): Promise<void> {
    const meta = this.metadata.find(changeSet.name)!;
    const wrapped = changeSet.entity.__helper!;
    const res = await this.driver.nativeInsert(changeSet.name, changeSet.payload, ctx);

    if (!wrapped.hasPrimaryKey()) {
      this.mapPrimaryKey(meta, res.insertId, changeSet);
    }

    this.mapReturnedValues(changeSet, res, meta);
    this.markAsPopulated(changeSet, meta);
    wrapped.__initialized = true;
    wrapped.__managed = true;
    await this.processOptimisticLock(meta, changeSet, res, ctx);
    changeSet.persisted = true;
  }

  private async persistManagedEntity<T extends AnyEntity<T>>(changeSet: ChangeSet<T>, ctx?: Transaction): Promise<void> {
    const meta = this.metadata.find(changeSet.name)!;
    const res = await this.updateEntity(meta, changeSet, ctx);
    this.mapReturnedValues(changeSet, res, meta);
    await this.processOptimisticLock(meta, changeSet, res, ctx);
    changeSet.persisted = true;
  }

  private mapPrimaryKey<T extends AnyEntity<T>>(meta: EntityMetadata<T>, value: IPrimaryKey, changeSet: ChangeSet<T>): void {
    const prop = meta.properties[meta.primaryKeys[0]];
    const insertId = prop.customType ? prop.customType.convertToJSValue(value, this.driver.getPlatform()) : value;
    const wrapped = changeSet.entity.__helper!;

    if (!wrapped.hasPrimaryKey()) {
      wrapped.__primaryKey = insertId;
    }

    changeSet.payload[wrapped.__meta.primaryKeys[0]] = value;
    wrapped.__identifier!.setValue(changeSet.entity[prop.name] as unknown as IPrimaryKey);
  }

  /**
   * Sets populate flag to new entities so they are serialized like if they were loaded from the db
   */
  private markAsPopulated<T extends AnyEntity<T>>(changeSet: ChangeSet<T>, meta: EntityMetadata<T>) {
    if (!this.config.get('populateAfterFlush')) {
      return;
    }

    changeSet.entity.__helper!.populated();
    meta.relations.forEach(prop => {
      const value = changeSet.entity[prop.name];

      if (Utils.isEntity(value, true)) {
        (value as AnyEntity).__helper!.populated();
      } else if (Utils.isCollection(value)) {
        value.populated();
      }
    });
  }

  private async updateEntity<T extends AnyEntity<T>>(meta: EntityMetadata<T>, changeSet: ChangeSet<T>, ctx?: Transaction): Promise<QueryResult> {
    if (!meta.versionProperty || !changeSet.entity[meta.versionProperty]) {
      return this.driver.nativeUpdate(changeSet.name, changeSet.entity.__helper!.__primaryKey as Dictionary, changeSet.payload, ctx);
    }

    const cond = {
      ...Utils.getPrimaryKeyCond<T>(changeSet.entity, meta.primaryKeys),
      [meta.versionProperty]: changeSet.entity[meta.versionProperty],
    } as FilterQuery<T>;

    return this.driver.nativeUpdate(changeSet.name, cond, changeSet.payload, ctx);
  }

  private async processOptimisticLock<T extends AnyEntity<T>>(meta: EntityMetadata<T>, changeSet: ChangeSet<T>, res: QueryResult | undefined, ctx?: Transaction) {
    if (!meta.versionProperty) {
      return;
    }

    if (changeSet.type === ChangeSetType.UPDATE && res && !res.affectedRows) {
      throw OptimisticLockError.lockFailed(changeSet.entity);
    }

    const e = await this.driver.findOne(meta.name!, changeSet.entity.__helper!.__primaryKey, {
      fields: [meta.versionProperty],
    }, ctx);

    // needed for sqlite
    if (meta.properties[meta.versionProperty].type.toLowerCase() === 'date') {
      changeSet.entity[meta.versionProperty] = new Date(e![meta.versionProperty] as unknown as string) as unknown as T[keyof T & string];
    } else {
      changeSet.entity[meta.versionProperty] = e![meta.versionProperty];
    }

    changeSet.payload![meta.versionProperty] = e![meta.versionProperty];
  }

  private processProperty<T extends AnyEntity<T>>(changeSet: ChangeSet<T>, prop: EntityProperty<T>): void {
    const value = changeSet.payload[prop.name];

    if (value as unknown instanceof EntityIdentifier) {
      changeSet.payload[prop.name] = value.getValue();
    }

    if (prop.onCreate && changeSet.type === ChangeSetType.CREATE) {
      changeSet.entity[prop.name] = changeSet.payload[prop.name] = prop.onCreate(changeSet.entity);

      if (prop.primary) {
        this.mapPrimaryKey(changeSet.entity.__meta!, changeSet.entity[prop.name] as unknown as IPrimaryKey, changeSet);
      }
    }

    if (prop.onUpdate && changeSet.type === ChangeSetType.UPDATE) {
      changeSet.entity[prop.name] = changeSet.payload[prop.name] = prop.onUpdate(changeSet.entity);
    }

    if (changeSet.payload[prop.name] as unknown instanceof Date) {
      changeSet.payload[prop.name] = this.driver.getPlatform().processDateProperty(changeSet.payload[prop.name]);
    }
  }

  /**
   * Maps values returned via `returning` statement (postgres) or the inserted id (other sql drivers).
   * No need to handle composite keys here as they need to be set upfront.
   * We do need to map to the change set payload too, as it will be used in the originalEntityData for new entities.
   */
  private mapReturnedValues<T extends AnyEntity<T>>(changeSet: ChangeSet<T>, res: QueryResult, meta: EntityMetadata<T>): void {
    if (res.row && Object.keys(res.row).length > 0) {
      const data = meta.props.reduce((ret, prop) => {
        if (prop.fieldNames && res.row![prop.fieldNames[0]] && !Utils.isDefined(changeSet.entity[prop.name], true)) {
          ret[prop.name] = changeSet.payload[prop.name] = res.row![prop.fieldNames[0]];
        }

        return ret;
      }, {} as Dictionary);
      this.hydrator.hydrate<T>(changeSet.entity, meta, data as EntityData<T>, false, true);
    }
  }

}
