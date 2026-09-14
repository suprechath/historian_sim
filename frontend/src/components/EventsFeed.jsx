import React, { useState, useEffect, useCallback } from 'react';

export default function EventsFeed({ selectedReactor = 'R1', onSelectReactor }) {
    const [events, setEvents] = useState([]);
    const [filterReactor, setFilterReactor] = useState(selectedReactor);
    const [filterLevel, setFilterLevel] = useState('ALL');
    const [loading, setLoading] = useState(false);

    // Keep internal filter in sync when parent vessel selection changes
    useEffect(() => {
        if (selectedReactor) {
            setFilterReactor(selectedReactor);
        }
    }, [selectedReactor]);

    const fetchEvents = useCallback(async (asset, level) => {
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
    }, []);

    useEffect(() => {
        fetchEvents(filterReactor, filterLevel);
        const interval = setInterval(() => {
            fetchEvents(filterReactor, filterLevel);
        }, 5000); // 5s auto-refresh for live alarms & event stream
        return () => clearInterval(interval);
    }, [filterReactor, filterLevel, fetchEvents]);

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
        <div className="panel events-feed-panel">
            {/* Filter & Refresh Toolbar */}
            <div className="events-toolbar">
                <div className="events-title-grp">
                    <span className="events-title">Events & Alarms Feed</span>
                    <span className="events-subtitle">ISA-88 phases, batch transitions & alarms</span>
                </div>

                <div className="events-controls">
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
                </div>
            </div>

            {/* Events Data Table */}
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
                                            {/* {e.tag_name && <span className="event-tag-sub">{e.tag_name}</span>} */}
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
        </div>
    );
}
