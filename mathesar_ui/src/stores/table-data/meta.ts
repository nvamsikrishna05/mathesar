import { writable, derived, get } from 'svelte/store';
import type { Writable, Readable } from 'svelte/store';
import type { TabularType, DBObjectEntry } from '@mathesar/App.d';
import type { SelectOption } from '@mathesar-components/types';

export const DEFAULT_PAGE_SIZE = 500;
export const RECORD_COMBINED_STATE_KEY = '__combined';

export type SortOption = Map<string, 'asc' | 'desc'>;
export type GroupOption = Set<string>;

export interface FilterEntry {
  column: SelectOption,
  condition: SelectOption,
  value: string
}

export interface FilterCombination extends SelectOption {
  id: 'and' | 'or',
  label: string
}

export const filterCombinations: FilterCombination[] = [
  { id: 'and', label: 'and' },
  { id: 'or', label: 'or' },
];

export interface FilterOption {
  combination: FilterCombination,
  filters: FilterEntry[]
}

export type UpdateModificationType = 'update' | 'updated' | 'updateFailed';

export type ModificationType = 'create' | 'created' | 'creationFailed'
| UpdateModificationType
| 'delete' | 'deleteFailed';

export type ModificationStatus = 'inprocess' | 'complete' | 'error' | 'idle';
export type ModificationStateMap = Map<unknown, Map<unknown, ModificationType>>;

const inProgressSet: Set<ModificationType> = new Set(['create', 'update', 'delete']);
const completeSet: Set<ModificationType> = new Set(['created', 'updated']);
const errorSet: Set<ModificationType> = new Set(['creationFailed', 'updateFailed', 'deleteFailed']);

export function getGenericModificationStatusByPK(
  recordModificationState: ModificationStateMap,
  primaryKeyValue: unknown,
): ModificationStatus {
  const type = recordModificationState.get(primaryKeyValue)?.get(RECORD_COMBINED_STATE_KEY);
  if (inProgressSet.has(type)) {
    return 'inprocess';
  }
  if (completeSet.has(type)) {
    return 'complete';
  }
  if (errorSet.has(type)) {
    return 'error';
  }
  return 'idle';
}

function getCombinedUpdateState(cellMap: Map<unknown, ModificationType>): UpdateModificationType {
  let state: UpdateModificationType = 'updated';
  // eslint-disable-next-line no-restricted-syntax
  for (const [key, value] of cellMap) {
    if (key !== RECORD_COMBINED_STATE_KEY) {
      if (value === 'update') {
        state = 'update';
        break;
      } else if (value === 'updateFailed') {
        state = 'updateFailed';
        break;
      }
    }
  }
  return state;
}

// The Meta store is meant to be used by other stores for storing and operating on meta information.
// This may also include display properties. Properties in Meta store do not depend on other stores.
// For display specific properties that depend on other stores, the Display store can be used.
export class Meta {
  _type: TabularType;

  _parentId: DBObjectEntry['id'];

  pageSize: Writable<number>;

  page: Writable<number>;

  offset: Readable<number>;

  sort: Writable<SortOption>;

  group: Writable<GroupOption>;

  filter: Writable<FilterOption>;

  selectedRecords: Writable<Set<unknown>>;

  // Row -> Cell -> Type
  recordModificationState: Writable<ModificationStateMap>;

  combinedModificationState: Readable<ModificationStatus>;

  recordRequestParams: Readable<string>;

  constructor(
    type: TabularType,
    parentId: number,
  ) {
    this._type = type;
    this._parentId = parentId;

    this.pageSize = writable(DEFAULT_PAGE_SIZE);
    this.page = writable(1);
    this.sort = writable(new Map() as SortOption);
    this.group = writable(new Set() as GroupOption);
    this.filter = writable({
      combination: filterCombinations[0],
      filters: [],
    });
    this.selectedRecords = writable(new Set());
    this.recordModificationState = writable(new Map() as ModificationStateMap);

    this.offset = derived([this.pageSize, this.page], ([$pageSize, $page], set) => {
      set($pageSize * ($page - 1));
    });
    this.combinedModificationState = derived(
      this.recordModificationState,
      ($recordModificationState, set) => {
        if ($recordModificationState.size === 0) {
          set('idle');
        } else {
          let finalState: ModificationStatus = 'idle';
          // eslint-disable-next-line no-restricted-syntax
          for (const value of $recordModificationState.values()) {
            const rowState = value?.get(RECORD_COMBINED_STATE_KEY);
            if (inProgressSet.has(rowState)) {
              finalState = 'inprocess';
              break;
            }
            if (errorSet.has(rowState)) {
              finalState = 'error';
            } else if (completeSet.has(rowState) && finalState === 'idle') {
              finalState = 'complete';
            }
          }
          set(finalState);
        }
      },
      'idle' as ModificationStatus,
    );
    this._setRecordRequestParamsStore();
  }

  _setRecordRequestParamsStore(): void {
    this.recordRequestParams = derived(
      [
        this.pageSize,
        this.offset,
        this.group,
        this.sort,
        this.filter,
      ],
      (
        [$pageSize, $offset, $group, $sort, $filter],
        set,
      ) => {
        const params: string[] = [];
        params.push(`limit=${$pageSize}`);
        params.push(`offset=${$offset}`);

        const groupOptions = Array.from($group ?? []);
        const groupSortOptions = groupOptions.map((field) => ({
          field,
          direction: $sort.get(field) ?? 'asc',
        }));

        let sortOptions: { 'field': string, 'direction': string }[] = [];
        $sort.forEach((value, key) => {
          if (!$group.has(key)) {
            sortOptions.unshift({
              field: key,
              direction: value,
            });
          }
        });

        sortOptions = [...groupSortOptions, ...sortOptions];

        if (sortOptions.length > 0) {
          params.push(`order_by=${encodeURIComponent(JSON.stringify(sortOptions))}`);
        }
        if (groupOptions.length > 0) {
          params.push(
            `group_count_by=${encodeURIComponent(JSON.stringify(groupOptions))}`,
          );
        }
        if ($filter.filters?.length > 0) {
          const filter = {};
          const terms = $filter.filters.map((term) => ({
            field: term.column.id,
            op: term.condition.id,
            value: term.value,
          }));
          filter[$filter.combination.id as string] = terms;
          params.push(
            `filters=${encodeURIComponent(JSON.stringify(filter))}`,
          );
        }
        set(params.join('&'));
      },
    );
  }

  clearSelectedRecords(): void {
    this.selectedRecords.set(new Set());
  }

  addFilter(entry: FilterEntry, combination?: FilterCombination): void {
    this.filter.update((existing) => ({
      combination: combination || existing.combination || filterCombinations[0],
      filters: [
        ...existing.filters,
        entry,
      ],
    }));
  }

  removeFilter(index: number): void {
    this.filter.update((existing) => {
      existing?.filters?.splice(index, 1);
      return {
        ...existing,
      };
    });
  }

  setFilterCombination(combination: FilterCombination): void {
    this.filter.update((existing) => ({
      ...existing,
      combination,
    }));
  }

  getFilterCombination(): FilterCombination {
    return get(this.filter)?.combination ?? filterCombinations[0];
  }

  setFilters(filters: FilterOption): void {
    this.filter.set(filters);
  }

  addUpdateSort(column: string, direction: 'asc' | 'desc' = 'asc'): void {
    this.sort.update((existing) => {
      const newSort: SortOption = new Map(existing);
      newSort.set(column, direction);
      return newSort;
    });
  }

  removeSort(column: string): void {
    this.sort.update((existing) => {
      const newSort = new Map(existing);
      newSort.delete(column);
      return newSort;
    });
  }

  changeSortDirection(column: string, direction: 'asc' | 'desc'): void {
    if (get(this.sort).get(column) !== direction) {
      this.sort.update((existing) => {
        const newSort = new Map(existing);
        newSort.set(column, direction);
        return newSort;
      });
    }
  }

  addGroup(column: string): void {
    if (!get(this.group).has(column)) {
      this.group.update((existing) => {
        const newGroup = new Set(existing);
        newGroup.add(column);
        return newGroup;
      });
    }
  }

  removeGroup(column: string): void {
    this.group.update((existing) => {
      const newGroup = new Set(existing);
      newGroup.delete(column);
      return newGroup;
    });
  }

  selectRecordByPrimaryKey(primaryKeyValue: unknown): void {
    if (!get(this.selectedRecords).has(primaryKeyValue)) {
      this.selectedRecords.update((existingSet) => {
        const newSet = new Set(existingSet);
        newSet.add(primaryKeyValue);
        return newSet;
      });
    }
  }

  deSelectRecordByPrimaryKey(primaryKeyValue: unknown): void {
    if (get(this.selectedRecords).has(primaryKeyValue)) {
      this.selectedRecords.update((existingSet) => {
        const newSet = new Set(existingSet);
        newSet.delete(primaryKeyValue);
        return newSet;
      });
    }
  }

  setRecordModificationState(key: unknown, state: ModificationType): void {
    this.recordModificationState.update((existingMap) => {
      const newMap = new Map(existingMap);
      let cellMap = newMap.get(key);
      if (!cellMap) {
        cellMap = new Map();
        newMap.set(key, cellMap);
      }
      cellMap.set(RECORD_COMBINED_STATE_KEY, state);
      return newMap;
    });
  }

  clearRecordModificationState(key: unknown): void {
    this.recordModificationState.update((existingMap) => {
      const newMap = new Map(existingMap);
      newMap.delete(key);
      return newMap;
    });
  }

  clearAllRecordModificationStates(): void {
    this.recordModificationState.set(new Map());
  }

  setCellUpdateState(
    recordKey: unknown,
    cellKey: unknown,
    state: UpdateModificationType,
  ): void {
    this.recordModificationState.update((existingMap) => {
      const newMap = new Map(existingMap);
      let cellMap = newMap.get(recordKey);
      if (!cellMap) {
        cellMap = new Map();
        newMap.set(recordKey, cellMap);
      }
      cellMap.set(cellKey, state);
      cellMap.set(RECORD_COMBINED_STATE_KEY, getCombinedUpdateState(cellMap));
      return newMap;
    });
  }

  setMultipleRecordModificationStates(
    keys: unknown[],
    state: ModificationType,
  ): void {
    this.recordModificationState.update((existingMap) => {
      const newMap = new Map(existingMap);
      keys.forEach((rowKey) => {
        let cellMap = newMap.get(rowKey);
        if (!cellMap) {
          cellMap = new Map();
          newMap.set(rowKey, cellMap);
        }
        cellMap.set(RECORD_COMBINED_STATE_KEY, state);
      });
      return newMap;
    });
  }

  clearMultipleRecordModificationStates(
    keys: unknown[],
  ): void {
    this.recordModificationState.update((existingMap) => {
      const newMap = new Map(existingMap);
      keys.forEach((value) => {
        newMap.delete(value);
      });
      return newMap;
    });
  }
}
