import { describe, expect, test } from 'vitest';
import { initialSidebarState, sidebarReducer } from '@/components/ui/sidebar-reducer';

describe('sidebarReducer search query', () => {
  test('UPDATE_SEARCH_QUERY stores the query', () => {
    const next = sidebarReducer(initialSidebarState, { type: 'UPDATE_SEARCH_QUERY', query: 'invoices' });
    expect(next.searchQuery).toBe('invoices');
  });

  test('UPDATE_SEARCH_QUERY leaves the other state untouched', () => {
    const next = sidebarReducer(initialSidebarState, { type: 'UPDATE_SEARCH_QUERY', query: 'invoices' });
    expect({ ...next, searchQuery: '' }).toEqual({ ...initialSidebarState, searchQuery: '' });
  });

  test('CLEAR_SEARCH resets the query and stops searching', () => {
    const searching = sidebarReducer(
      sidebarReducer(initialSidebarState, { type: 'TOGGLE_SEARCH' }),
      { type: 'UPDATE_SEARCH_QUERY', query: 'invoices' },
    );
    const cleared = sidebarReducer(searching, { type: 'CLEAR_SEARCH' });
    expect(cleared.isSearching).toBe(false);
    expect(cleared.searchQuery).toBe('');
  });

  test('initial state starts with an empty query and a Set of collapsed folders', () => {
    expect(initialSidebarState.searchQuery).toBe('');
    expect(initialSidebarState.collapsedFolders).toBeInstanceOf(Set);
  });
});
