import React, { useState, useEffect, useCallback } from 'react';

export default function EventsFeed({ selectedReactor = 'R1', onSelectReactor }) {
    const [events, setEvents] = useState([]);
    const [filterReactor, setFilterReactor] = useState(selectedReactor);
    const [filterLevel, setFilterLevel] = useState('ALL');
    const [loading, setLoading] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(() => {
        try {
            return localStorage.getItem('historian_events_collapsed') === 'true';
        } catch {
            return false;
        }
    });

    const toggleCollapse = () => {
        setIsCollapsed(prev => {
            const next = !prev;
            try {
                localStorage.setItem('historian_events_collapsed', String(next));
            } catch {
                // Ignore storage errors
            }
            return next;
        });
    };

    // Keep internal filter in sync when parent vessel selection changes
    useEffect(() => {
        if (selectedReactor) {
            setFilterReactor(selectedReactor);
        }
    }, [selectedReactor]);

    const fetchEvents = useCallback(async (asset, level) => {
        if (isCollapsed) return;
        setLoading(true);
        try {
            const params = new URLSearchParams({ limit: '40' });
            if (asset && asset !== 'ALL') params.append('asset', asset);
            if (level && level !== 'ALL') params.append('level', level);

            const res = await fetch(`/ui/events?${params.toString()}`);
            if (res.ok) {
                const data = await res.json();
                setEvents(data);
            }
        } catch (err) {
            console.error('Failed to load events and alarms feed:', err);
        } finally {
            setLoading(false);
        }
    }, [isCollapsed]);

    useEffect(() => {
        if (isCollapsed) return;
        fetchEvents(filterReactor, filterLevel);
        const interval = setInterval(() => {
            fetchEvents(filterReactor, filterLevel);
        }, 5000); // 5s auto-refresh for live alarms & event stream
        return () => clearInterval(interval);
    }, [filterReactor, filterLevel, fetchEvents, isCollapsed]);

    const handleReactorChange = (r) => {
        setFilterReactor(r);
        if (r !== 'ALL' && onSelectReactor) {
            onSelectReactor(r);
        }
    };

    const formatTime = (ts) => {
        if (!ts) return '—';
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    };

    const getDuration = (start, end) => {
        if (!start) return '—';
        if (!end) return 'Active';
        const ms = new Date(end).getTime() - new Date(start).getTime();
        const sec = Math.round(ms / 1000);
        if (sec < 60) return `${sec}s`;
        const min = Math.floor(sec / 60);
        const remSec = sec % 60;
        return `${min}m ${remSec}s`;
    };

    return (
        <div className={`panel events-feed-panel ${isCollapsed ? 'collapsed' : ''}`}>
            {/* Filter & Refresh Toolbar */}
            <div className="events-toolbar">
                <div
                    className="events-title-grp events-title-clickable"
                    onClick={toggleCollapse}
                    title={isCollapsed ? "Click to expand Events & Process Alarms Feed" : "Click to collapse Events & Process Alarms Feed"}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="events-title">Events & Alarms Feed</span>
                        {isCollapsed && (
                            <span className="trend-collapsed-pill">Collapsed</span>
                        )}
                    </div>
                    <span className="events-subtitle">
                        {isCollapsed
                            ? 'Click Expand or header to view events feed'
                            : 'ISA-88 phases, batch transitions & alarms'}
                    </span>
                </div>

                <div className="events-controls">
                    {!isCollapsed && (
                        <>
                            {/* Reactor Filter */}
                            <div className="vessel-filter-grp" role="group" aria-label="Filter events by reactor">
                                {['ALL', 'R1', 'R2', 'R3'].map(r => (
                                    <button
                                        key={r}
                                        type="button"
                                        className={`vessel-filter-btn ${filterReactor === r ? 'active' : ''}`}
                                        onClick={() => handleReactorChange(r)}>
                                        {r}
                                    </button>
                                ))}
                            </div>

                            {/* Level Filter */}
                            <div className="level-filter-grp" role="group" aria-label="Filter events by level">
                                {[
                                    { label: 'All', val: 'ALL' },
                                    { label: 'Alarms', val: 'Alarm' },
                                    { label: 'Phases', val: 'Phase' },
                                    { label: 'States', val: 'StateChange' }
                                ].map(l => (
                                    <button
                                        key={l.val}
                                        type="button"
                                        className={`level-filter-btn ${filterLevel === l.val ? 'active' : ''}`}
                                        onClick={() => setFilterLevel(l.val)}>
                                        {l.label}
                                    </button>
                                ))}
                            </div>

                            <button
                                type="button"
                                className="btn-refresh"
                                onClick={() => fetchEvents(filterReactor, filterLevel)}
                                title="Refresh events feed now">
                                {loading ? '⟳…' : '⟳ Refresh'}
                            </button>
                        </>
                    )}

                    {/* Collapse / Expand Toggle Button */}
                    <button
                        type="button"
                        className={`trend-collapse-btn ${isCollapsed ? 'collapsed' : ''}`}
                        onClick={toggleCollapse}
                        title={isCollapsed ? "Expand Events Feed" : "Collapse Events Feed"}
                        aria-expanded={!isCollapsed}>
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            style={{
                                transition: 'transform 0.2s ease',
                                transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'
                            }}>
                            <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z" />
                        </svg>
                        <span>{isCollapsed ? 'Expand' : 'Collapse'}</span>
                    </button>
                </div>
            </div>

            {/* Events Data Table */}
            {!isCollapsed && (
                <div className="events-table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th style={{ width: '75px' }}>Time</th>
                                <th style={{ width: '120px' }}>Level</th>
                                <th style={{ width: '50px' }}>Unit</th>
                                <th>Event / Alarm Description</th>
                                <th style={{ width: '150px' }}>Batch</th>
                                <th style={{ textAlign: 'right', width: '120px' }}>Active / Duration</th>
                            </tr>
                        </thead>
                        <tbody>
                            {events.length === 0 ? (
                                <tr>
                                    <td colSpan="6" className="events-empty">
                                        {loading ? 'Loading events feed…' : `No events recorded for ${filterReactor}`}
                                    </td>
                                </tr>
                            ) : (
                                events.map(e => {
                                    const isAlarm = e.level === 'Alarm';
                                    const isPhase = e.level === 'Phase';
                                    const isActive = !e.ended_at;

                                    let badgeClass = 'state';
                                    if (isAlarm) badgeClass = 'alarm';
                                    else if (isPhase) badgeClass = 'phase';

                                    return (
                                        <tr key={e.id} className={isAlarm && isActive ? 'alarm-active-row' : ''}>
                                            <td className="mono muted">{formatTime(e.started_at)}</td>
                                            <td>
                                                <span className={`event-level-pill ${badgeClass}`}>
                                                    {isAlarm && <i className="alarm-dot" />}
                                                    {e.level}
                                                </span>
                                            </td>
                                            <td>
                                                <span className="vessel-badge">{e.asset}</span>
                                            </td>
                                            <td className={`event-name-cell ${isAlarm ? 'alarm-text' : ''}`} title={e.name}>
                                                <b>{e.name}</b>
                                            </td>
                                            <td className="mono muted">
                                                {e.batch_id ? (
                                                    <span className="batch-pill">{e.batch_id}</span>
                                                ) : (
                                                    '—'
                                                )}
                                            </td>
                                            <td style={{ textAlign: 'right' }}>
                                                {isActive ? (
                                                    <span className={`status-active-pill ${isAlarm ? 'alarm' : 'running'}`}>
                                                        ACTIVE
                                                    </span>
                                                ) : (
                                                    <span className="mono muted">{getDuration(e.started_at, e.ended_at)}</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
