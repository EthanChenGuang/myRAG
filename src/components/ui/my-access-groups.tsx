'use client';

import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/components/providers/language-provider';
import { accessGroupText } from '@/components/ui/access-group-labels';
import {
  useAccessGroupsStore,
  type AccessGroupOption,
  type AccessGroupsLoadStatus,
  type AccessGroupsMine,
} from '@/lib/stores/access-groups-store';

export interface MyAccessGroupsInput {
  mine: AccessGroupsMine;
  status: AccessGroupsLoadStatus;
  error: string | null;
  /** The last answer for this workspace said the switch is on. */
  knownEnabled: boolean;
  singleTenant: boolean;
  /** A Reload groups press is in flight: the unavailable line stays, its button disabled. */
  retrying?: boolean;
}

export type MyAccessGroupsViewModel =
  | { kind: 'hidden' }
  | { kind: 'groups'; title: string; chips: AccessGroupOption[]; help: string }
  | { kind: 'text'; title: string; text: string }
  | { kind: 'unavailable'; title: string; text: string; reload: string; busy: boolean };

const SERVER_FAILURE = /^access_groups_mine_5\d\d$/;

/**
 * A server failure (5xx) comes after the route's switch check, so the switch is on. A network failure or a timeout
 * says nothing about the switch: it shows the unavailable line only when an earlier answer was enabled, otherwise
 * nothing (today's view). A refused request (signed out, not a member) shows nothing.
 */
function failureShown(error: string | null, knownEnabled: boolean): boolean {
  if (!error) return false;
  if (SERVER_FAILURE.test(error)) return true;
  if (error === 'access_groups_mine_network' || error === 'access_groups_mine_timeout') return knownEnabled;
  return false;
}

/** The member's own groups (D-29, UI-SPEC 6.12): names only, never another group, a member or a count. */
export function buildMyAccessGroupsView(input: MyAccessGroupsInput, language: string): MyAccessGroupsViewModel {
  const title = accessGroupText('mine.title', language);
  const retrying = input.status === 'loading' && input.retrying === true;
  if (input.status === 'error' || retrying) {
    if (!retrying && !failureShown(input.error, input.knownEnabled)) return { kind: 'hidden' };
    return {
      kind: 'unavailable',
      title,
      text: accessGroupText('mine.unavailable', language),
      reload: accessGroupText('action.reloadGroups', language),
      busy: retrying,
    };
  }
  if (input.status !== 'ready' || !input.mine.enabled || input.mine.personal) return { kind: 'hidden' };
  if (input.mine.isAdmin) {
    return { kind: 'text', title, text: accessGroupText(input.singleTenant ? 'mine.adminSingle' : 'mine.admin', language) };
  }
  if (input.mine.ownGroups.length === 0) return { kind: 'text', title, text: accessGroupText('mine.none', language) };
  return {
    kind: 'groups',
    title,
    chips: input.mine.ownGroups.map(({ id, name }) => ({ id, name })),
    help: accessGroupText('mine.help', language),
  };
}

interface MyAccessGroupsViewProps {
  view: MyAccessGroupsViewModel;
  onReload: () => void;
  /** `card`: a row inside the Workspace tab's organization card; `section`: a General tab section. */
  variant?: 'card' | 'section';
}

export function MyAccessGroupsView({ view, onReload, variant = 'card' }: MyAccessGroupsViewProps) {
  if (view.kind === 'hidden') return null;
  const title =
    variant === 'section' ? (
      <h4 className="text-base font-medium text-gray-900 dark:text-white">{view.title}</h4>
    ) : (
      <p className="text-sm text-gray-600 dark:text-gray-400">{view.title}</p>
    );
  return (
    <div className={variant === 'section' ? 'space-y-2 pb-4 border-b border-[#FFE0D0] dark:border-[#2A2A2A]' : 'mb-4 space-y-2'}>
      {title}
      {view.kind === 'groups' && (
        <>
          <ul aria-label={view.title} className="flex flex-wrap gap-1.5">
            {view.chips.map((group) => (
              <li
                key={group.id}
                title={group.name}
                className="max-w-full truncate rounded border border-[#FFE0D0] dark:border-[#2A2A2A] bg-white dark:bg-[#2A2A2A] px-2 py-0.5 text-sm text-gray-900 dark:text-white"
              >
                {group.name}
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-600 dark:text-gray-400">{view.help}</p>
        </>
      )}
      {view.kind === 'text' && <p className="text-sm text-gray-600 dark:text-gray-400">{view.text}</p>}
      {view.kind === 'unavailable' && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-gray-600 dark:text-gray-400">{view.text}</p>
          <Button type="button" variant="outline" size="sm" onClick={onReload} disabled={view.busy} aria-busy={view.busy}>
            {view.reload}
          </Button>
        </div>
      )}
    </div>
  );
}

interface MyAccessGroupsProps {
  /** The team workspace (multi-tenant), or null for the single-tenant deployment. */
  organizationId: string | null;
  singleTenant: boolean;
  variant?: 'card' | 'section';
}

/** Read-only member view of the caller's own access groups, fed by the mine answer (plan 46 store). */
export function MyAccessGroups({ organizationId, singleTenant, variant }: MyAccessGroupsProps) {
  const { language } = useLanguage();
  const { mine, status, error, workspace, load } = useAccessGroupsStore(
    useShallow((s) => ({ mine: s.mine, status: s.status, error: s.error, workspace: s.workspace, load: s.load })),
  );
  const workspaceKey = organizationId ?? 'personal';
  const [enabledSeen, setEnabledSeen] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    void load(organizationId);
  }, [organizationId, load]);

  const current = workspace === workspaceKey;
  const answeredEnabled = current && status === 'ready' && mine.enabled;

  useEffect(() => {
    if (answeredEnabled) setEnabledSeen(workspaceKey);
  }, [answeredEnabled, workspaceKey]);

  useEffect(() => {
    if (status !== 'loading') setRetrying(false);
  }, [status]);

  const view = current
    ? buildMyAccessGroupsView(
        { mine, status, error, knownEnabled: enabledSeen === workspaceKey, singleTenant, retrying },
        language,
      )
    : ({ kind: 'hidden' } as const);

  const reload = () => {
    setRetrying(true);
    void load(organizationId);
  };

  return <MyAccessGroupsView view={view} onReload={reload} variant={variant} />;
}
