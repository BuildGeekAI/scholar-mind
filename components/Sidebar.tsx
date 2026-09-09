import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  ChevronRight,
  Download,
  LogOut,
  Moon,
  Plus,
  Search,
  Sun,
  Trash2,
  UserRoundCog,
  Users,
  X,
} from 'lucide-react';
import { Theme } from './theme';
import * as api from '../services/api';
import type { Focus } from './ChatPane';

/**
 * Libraries and advisors, always on screen.
 *
 * They were a grid below the answer box, which meant scrolling away from the
 * conversation to see what you could ask about. Here they stay put, and what the
 * current tab is determines what selecting one *does*: narrowing the libraries
 * focus, or adding an advisor to the panel.
 */

interface Props {
  profiles: api.ProfileRecord[];
  advisors: api.Advisor[];
  focus: Focus;
  libraryId: string | null;
  advisorIds: string[];
  me: api.Me | null;
  theme: Theme;
  onSelectLibrary: (id: string | null) => void;
  onToggleAdvisor: (id: string) => void;
  onOpenProfile: (id: string) => void;
  onCreateProfile: () => void;
  onDeleteProfile: (id: string, e: React.MouseEvent) => void;
  onToggleTheme: () => void;
}

const Sidebar: React.FC<Props> = ({
  profiles,
  advisors,
  focus,
  libraryId,
  advisorIds,
  me,
  theme,
  onSelectLibrary,
  onToggleAdvisor,
  onOpenProfile,
  onCreateProfile,
  onDeleteProfile,
  onToggleTheme,
}) => {
  const [term, setTerm] = useState('');
  const [subject, setSubject] = useState<string | null>(null);

  /** Subjects come from the topics a scholar search already resolved. */
  const subjects = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of profiles) {
      for (const topic of p.topics ?? []) {
        const key = topic.trim();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8);
  }, [profiles]);

  const shown = useMemo(
    () =>
      profiles
        .filter(p =>
          `${p.title} ${p.scholarName ?? ''}`.toLowerCase().includes(term.toLowerCase())
        )
        .filter(p => !subject || (p.topics ?? []).some(t => t.trim() === subject))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [profiles, term, subject]
  );

  const ready = advisors.filter(a => a.indexedCount > 0);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex shrink-0 items-center gap-2.5 px-4 py-4">
        <div className="rounded-lg bg-gradient-to-br from-scholarly-500 to-scholarly-700 p-2 shadow-md shadow-scholarly-500/25">
          <BookOpen className="h-4 w-4 text-white" aria-hidden />
        </div>
        <span className="font-serif text-base text-ink">ScholarMind</span>
      </div>

      <div className="shrink-0 px-4 pb-3">
        <button
          onClick={onCreateProfile}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-3 py-2 text-sm font-medium text-surface transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" aria-hidden /> New library
        </button>
      </div>

      <div className="shrink-0 px-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-subtle" aria-hidden />
          <label htmlFor="filter-libraries" className="sr-only">Filter libraries</label>
          <input
            id="filter-libraries"
            value={term}
            onChange={e => setTerm(e.target.value)}
            placeholder="Filter…"
            className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-7 text-xs text-ink outline-none focus:border-scholarly-500"
          />
          {term && (
            <button
              onClick={() => setTerm('')}
              className="absolute right-2 top-2 text-subtle hover:text-ink"
              aria-label="Clear filter"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {subjects.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {subjects.map(([name, count]) => (
              <button
                key={name}
                onClick={() => setSubject(s => (s === name ? null : name))}
                aria-pressed={subject === name}
                title={`${count} ${count === 1 ? 'library' : 'libraries'}`}
                className={`rounded-full px-2 py-0.5 text-[11px] transition ${
                  subject === name ? 'bg-ink text-surface' : 'bg-panel-2 text-muted hover:text-ink'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {focus === 'advisors' ? (
          <section>
            <h2 className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-subtle">
              Advisors — pick one or several
            </h2>
            {ready.length === 0 ? (
              <p className="px-2 py-2 text-xs text-subtle">
                None yet. Open a library and turn it into an advisor.
              </p>
            ) : (
              ready.map(advisor => {
                const on = advisorIds.includes(advisor.id);
                const name = advisor.advisorName || advisor.scholarName || advisor.title;
                return (
                  <button
                    key={advisor.id}
                    onClick={() => onToggleAdvisor(advisor.id)}
                    aria-pressed={on}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${
                      on ? 'bg-scholarly-50 text-ink dark:bg-scholarly-500/15' : 'text-muted hover:bg-panel-2 hover:text-ink'
                    }`}
                  >
                    <span aria-hidden>{advisor.emoji}</span>
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {advisor.deepCount === 0 && (
                      <span title="Abstracts only — answers will be shallow" className="text-amber-500">•</span>
                    )}
                    {on && <UserRoundCog className="h-3.5 w-3.5 shrink-0 text-scholarly-600 dark:text-scholarly-400" aria-hidden />}
                  </button>
                );
              })
            )}
          </section>
        ) : (
          <section>
            <div className="flex items-center justify-between px-2 py-1.5">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-subtle">
                Libraries
              </h2>
              {libraryId && (
                <button onClick={() => onSelectLibrary(null)} className="text-[11px] text-muted underline hover:text-ink">
                  all
                </button>
              )}
            </div>

            {shown.length === 0 ? (
              <p className="px-2 py-2 text-xs text-subtle">
                {profiles.length ? 'Nothing matches.' : 'No libraries yet.'}
              </p>
            ) : (
              shown.map(profile => {
                const active = libraryId === profile.id;
                // Only the owner may delete, so only the owner is offered it.
                // Showing the control to everyone meant a shared library
                // presented a trash icon that silently 404'd.
                const mine = !me || profile.ownerId === me.userId;
                return (
                  <div
                    key={profile.id}
                    className={`group flex items-center gap-2 rounded-lg px-2 py-2 transition ${
                      active ? 'bg-scholarly-50 dark:bg-scholarly-500/15' : 'hover:bg-panel-2'
                    }`}
                  >
                    {/* Selecting narrows the chat; the arrow opens the library
                        itself. Two different intentions, two targets. */}
                    <button
                      onClick={() => onSelectLibrary(active ? null : profile.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                      title={active ? 'Stop focusing on this library' : 'Focus the chat on this library'}
                    >
                      <span aria-hidden>{profile.emoji}</span>
                      <span className={`min-w-0 flex-1 truncate ${active ? 'text-ink' : 'text-muted'}`}>
                        {profile.title}
                      </span>
                    </button>

                    <a
                      href={api.exportUrl(profile.id)}
                      onClick={e => e.stopPropagation()}
                      className="shrink-0 text-subtle opacity-0 transition hover:text-ink group-hover:opacity-100 focus:opacity-100"
                      title={`Export ${profile.title}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                    {mine ? (
                      <button
                        onClick={e => onDeleteProfile(profile.id, e)}
                        className="shrink-0 text-subtle opacity-0 transition hover:text-red-500 group-hover:opacity-100 focus:opacity-100"
                        title={`Delete ${profile.title}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span
                        className="shrink-0 text-subtle opacity-0 transition group-hover:opacity-100"
                        title={`Shared with you — ${profile.title} belongs to someone else`}
                      >
                        <Users className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <button
                      onClick={() => onOpenProfile(profile.id)}
                      className="shrink-0 text-subtle transition hover:text-ink"
                      title={`Open ${profile.title}`}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                );
              })
            )}
          </section>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-3 py-3">
        <div className="flex items-center gap-2">
          {me && (
            <span className="min-w-0 flex-1 truncate text-xs text-subtle" title={me.email}>
              {me.email}
            </span>
          )}
          <button
            onClick={onToggleTheme}
            className="rounded-lg p-1.5 text-muted transition hover:bg-panel-2 hover:text-ink"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          {me && (
            <button
              onClick={() => api.signOut()}
              className="rounded-lg p-1.5 text-muted transition hover:bg-panel-2 hover:text-ink"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="mt-2 text-center text-[10px] text-subtle">
          © {new Date().getFullYear()}{' '}
          <a href="https://buildgeek.ai" target="_blank" rel="noopener noreferrer" className="underline">
            buildgeek.ai
          </a>
        </p>
      </div>
    </aside>
  );
};

export default Sidebar;
