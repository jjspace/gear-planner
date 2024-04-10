import {processRawMateriaInfo, XivApiFoodInfo, XivApiGearInfo} from "./gear";
import {getClassJobStats, JobName, MATERIA_LEVEL_MAX_NORMAL, SupportedLevel} from "./xivconstants";
import {GearItem, JobMultipliers, Materia, OccGearSlotKey, RawStatKey,} from "./geartypes";
import {xivApiGet, xivApiSingle} from "./external/xivapi";
import {BaseParamToStatKey, xivApiStatMapping} from "./external/xivapitypes";
import {getRelicStatModelFor} from "./relicstats/relicstats";

export type IlvlSyncInfo = {
    readonly ilvl: number;
    substatCap(slot: OccGearSlotKey, statsKey: RawStatKey): number;
}

export function queryBaseParams() {
    return xivApiGet({
        requestType: "list",
        sheet: 'BaseParam',
        columns: ['ID', 'Name', '1HWpn%', '2HWpn%', 'Bracelet%', 'Chest%', 'Earring%', 'Feet%', 'Hands%', 'Head%', 'Legs%', 'Necklace%', 'OH%', 'Ring%'] as const
    }).then(data => {
        console.log(`Got ${data.Results.length} BaseParams`);
        return data;
    });
}

export type BaseParamInfo = Record<OccGearSlotKey, number>
export type BaseParamMap = { [rawStat in RawStatKey]?: BaseParamInfo }

export class DataManager {
    allItems: XivApiGearInfo[];
    allMateria: Materia[];
    allFoodItems: XivApiFoodInfo[];

    minIlvl = 570;
    maxIlvl = 999;
    minIlvlFood = 540;
    maxIlvlFood = 999;
    classJob: JobName = 'WHM'
    level: SupportedLevel = 90;
    ilvlSync: number | undefined;

    jobMultipliers: Map<JobName, JobMultipliers>;

    baseParams: BaseParamMap;
    ilvlSyncDatum = new Map<number, Promise<IlvlSyncInfo>>();

    getIlvlSyncData(baseParamPromise: ReturnType<typeof queryBaseParams>, ilvl: number) {
        if (this.ilvlSyncDatum.has(ilvl)) {
            return this.ilvlSyncDatum.get(ilvl)
        }
        else {
            const jobStats = getClassJobStats(this.classJob);
            const ilvlPromise = Promise.all([baseParamPromise, xivApiSingle("ItemLevel", ilvl)]).then(responses => {
                const ilvlStatModifiers = new Map<RawStatKey, number>();
                // Unroll the ItemLevel object into a direct mapping from RawStatKey => modifier
                for (let respElementKey in responses[1]) {
                    if (respElementKey in xivApiStatMapping) {
                        ilvlStatModifiers.set(xivApiStatMapping[respElementKey], responses[1][respElementKey]);
                    }
                }
                // BaseParam data is trickier. First, we need to convert from a list to a map, where the keys are the stat.
                const baseParams = this.baseParams;
                return {
                    ilvl: ilvl,
                    substatCap(slot: OccGearSlotKey, statsKey: RawStatKey): number {
                        const ilvlModifier: number = ilvlStatModifiers.get(statsKey as RawStatKey);
                        const baseParamModifier = baseParams[statsKey as RawStatKey][slot];
                        const multi = jobStats.itemStatCapMultipliers?.[statsKey];
                        if (multi) {
                            return Math.round(multi * Math.round(ilvlModifier * baseParamModifier / 1000));
                        }
                        else {
                            return Math.round(ilvlModifier * baseParamModifier / 1000);
                        }
                    },
                } as const;
            });
            this.ilvlSyncDatum.set(ilvl, ilvlPromise);
            return ilvlPromise;
        }
    }

    itemById(id: number): (GearItem | undefined) {
        return this.allItems.find(item => item.id === id);
    }

    materiaById(id: number): (Materia | undefined) {
        if (id < 0) {
            return undefined;
        }
        return this.allMateria.find(item => item.id === id);
    }

    foodById(id: number) {
        return this.allFoodItems.find(food => food.id === id);
    }


    async loadData() {
        const baseParamPromise = queryBaseParams().then(data => {
            this.baseParams = data.Results.reduce<{
                [rawStat in RawStatKey]?: Record<OccGearSlotKey, number>
            }>((baseParams, value) => {
                // Each individual item also gets converted
                baseParams[BaseParamToStatKey[value.Name]] = {
                    Body: value['Chest%'],
                    Ears: value['Earring%'],
                    Feet: value['Feet%'],
                    Hand: value['Hands%'],
                    Head: value['Head%'],
                    Legs: value['Legs%'],
                    Neck: value['Necklace%'],
                    OffHand: value['OH%'],
                    Ring: value['Ring%'],
                    Weapon2H: value['2HWpn%'],
                    Weapon1H: value['1HWpn%'],
                    Wrist: value['Bracelet%']
                };
                return baseParams;
            }, {});
            return data;
        });
        const extraPromises = [];
        console.log("Loading items");
        // Gear Items
        const itemsPromise = xivApiGet({
            requestType: 'search',
            sheet: 'Item',
            columns: [
                // Basic item properties
                'ID', 'IconHD', 'Name', 'LevelItem',
                // Equip slot restrictions
                'EquipSlotCategory', 'IsUnique',
                // Stats
                'Stats', 'DamageMag', 'DamagePhys', 'DelayMs',
                // Materia
                'MateriaSlotCount', 'IsAdvancedMeldingPermitted',
                // Stuff for determining correct WD for HQ crafted items
                'CanBeHq',
                'BaseParamSpecial0TargetID',
                'BaseParamSpecial1TargetID',
                'BaseParamSpecial2TargetID',
                'BaseParamSpecial3TargetID',
                'BaseParamSpecial4TargetID',
                'BaseParamSpecial5TargetID',
                'BaseParamValueSpecial0',
                'BaseParamValueSpecial1',
                'BaseParamValueSpecial2',
                'BaseParamValueSpecial3',
                'BaseParamValueSpecial4',
                'BaseParamValueSpecial5',
                // Helps determine acquisition type
                'Rarity',
                'GameContentLinks'
            ] as const,
            // EquipSlotCategory! => EquipSlotCategory is not null => filters out now-useless belts
            filters: [`LevelItem>=${this.minIlvl}`, `LevelItem<=${this.maxIlvl}`, `ClassJobCategory.${this.classJob}=1`, 'EquipSlotCategory!'],
        })
            // const itemsPromise = fetch(`https://xivapi.com/search?indexes=Item&filters=LevelItem%3E=${this.minIlvl},LevelItem%3C=${this.maxIlvl},ClassJobCategory.${this.classJob}=1&columns=ID,IconHD,Name,LevelItem,Stats,EquipSlotCategory,MateriaSlotCount,IsAdvancedMeldingPermitted,DamageMag,DamagePhys`)
            .then((data) => {
                if (data) {
                    console.log(`Got ${data.Results.length} Items`);
                    return data.Results;
                }
                else {
                    console.error(`Got No Items!`);
                    return null;
                }
            }).then((rawItems) => {
                this.allItems = rawItems
                    // TODO: filtering out items with no stats excludes all BLU weapons
                    // .filter(i => i['Stats'] !== null)
                    .map(i => new XivApiGearInfo(i));
                // TODO: put up better error
            }, (e) => console.error(e));
        const statsPromise = Promise.all([itemsPromise, baseParamPromise]).then(() => {
            console.log(`Finishing item calculations for ${this.allItems.length} items`);
            this.allItems.forEach(item => {
                const itemIlvlPromise = this.getIlvlSyncData(baseParamPromise, item.ilvl);
                if (this.ilvlSync) {
                    const ilvlSyncPromise = this.getIlvlSyncData(baseParamPromise, this.ilvlSync);
                    extraPromises.push(Promise.all([itemIlvlPromise, ilvlSyncPromise]).then(([native, sync]) => {
                        item.applyIlvlData(native, sync);
                        if (item.isCustomRelic) {
                            console.log('Applying relic model')
                            item.relicStatModel = getRelicStatModelFor(item, this.baseParams);
                            console.log('Applied', item.relicStatModel)
                        }
                    }));
                }
                else {
                    extraPromises.push(itemIlvlPromise.then(native => {
                        item.applyIlvlData(native);
                        if (item.isCustomRelic) {
                            console.log('Applying relic model')
                            item.relicStatModel = getRelicStatModelFor(item, this.baseParams);
                            console.log('Applied', item.relicStatModel)
                        }
                    }));
                }
            });
        });

        // Materia
        const matCols = ['ID', 'Value*', 'BaseParam.ID'];
        for (let i = 0; i < MATERIA_LEVEL_MAX_NORMAL; i++) {
            matCols.push(`Item${i}.Name`);
            // TODO: normal or HD icon?
            matCols.push(`Item${i}.IconHD`);
            matCols.push(`Item${i}.ID`);
        }
        console.log("Loading materia");
        const materiaPromise = xivApiGet({
            requestType: 'list',
            sheet: 'Materia',
            columns: matCols,
            pageLimit: 1
        })
            // const materiaPromise = fetch(`https://xivapi.com/Materia?columns=${matCols.join(',')}`)
            .then((data) => {
                if (data) {
                    console.log(`Got ${data.Results.length} Materia Types`);
                    this.allMateria = data.Results
                        .filter(i => i['Value' + (MATERIA_LEVEL_MAX_NORMAL - 1)])
                        .flatMap(item => {
                            return processRawMateriaInfo(item);
                        });
                    console.log(`Processed ${this.allMateria.length} total Materia items`);
                }
                else {
                    console.error('Got No Materia!');
                }
            }, e => {
                console.error(e);
            });
        console.log("Loading food");
        const foodPromise = xivApiGet({
            requestType: 'search',
            sheet: 'Item',
            filters: ['ItemKind.ID=5', 'ItemSearchCategory.ID=45', `LevelItem%3E=${this.minIlvlFood}`, `LevelItem%3C=${this.maxIlvlFood}`],
            columns: ['ID', 'IconHD', 'Name', 'LevelItem', 'Bonuses'] as const
        })
            // const foodPromise = fetch(`https://xivapi.com/search?indexes=Item&filters=ItemKind.ID=5,ItemSearchCategory.ID=45,LevelItem%3E=${this.minIlvlFood},LevelItem%3C=${this.maxIlvlFood}&columns=ID,IconHD,Name,LevelItem,Bonuses`)
            .then((data) => {
                console.log(`Got ${data.Results.length} Food Items`);
                return data.Results;
            })
            .then((rawFoods) => rawFoods.map(i => new XivApiFoodInfo(i)))
            .then((processedFoods) => processedFoods.filter(food => Object.keys(food.bonuses).length > 1))
            .then((foods) => this.allFoodItems = foods,
                e => console.error(e));
        console.log("Loading jobs");
        const jobsPromise = xivApiGet({
            requestType: "list",
            sheet: "ClassJob",
            columns: ['Abbreviation', 'ModifierDexterity', 'ModifierIntelligence', 'ModifierMind', 'ModifierStrength', 'ModifierVitality', 'ModifierHitPoints'] as const
        })
            .then(data => {
                console.log(`Got ${data.Results.length} Jobs`);
                return data.Results;
            })
            .then(rawJobs => {
                this.jobMultipliers = new Map<JobName, JobMultipliers>();
                for (let rawJob of rawJobs) {
                    this.jobMultipliers.set(rawJob['Abbreviation'], {
                        dexterity: rawJob.ModifierDexterity,
                        intelligence: rawJob.ModifierIntelligence,
                        mind: rawJob.ModifierMind,
                        strength: rawJob.ModifierStrength,
                        vitality: rawJob.ModifierVitality,
                        hp: rawJob.ModifierHitPoints,
                    })
                }
            });
        await Promise.all([baseParamPromise, itemsPromise, statsPromise, materiaPromise, foodPromise, jobsPromise]);
        await Promise.all(extraPromises);
    }

    multipliersForJob(job: JobName) {
        if (!this.jobMultipliers) {
            throw Error("You must wait for loadData() before calling this method");
        }
        const multi = this.jobMultipliers.get(job);
        if (!multi) {
            throw Error(`No data for job ${job}`)
        }
        return multi;
    }
}
