import React, { useState, useEffect, useCallback } from 'react';

export default function TagTable({ selectedReactor = 'R1', onSelectReactor }) {
    const [rollups, setRollups] = useState([]);
    const [filterReactor, setFilterReactor] = useState(selectedReactor);
    const [loading, setLoading] = useState(false);

    // Keep internal filter in sync when parent vessel selection changes
    useEffect(() => {
        if (selectedReactor) {
            setFilterReactor(selectedReactor);
        }
    }, [selectedReactor]);

    const fetchRollups = useCallback(async (asset) => {
        setLoading(true);
        try {
            const url = asset && asset !== 'ALL'
                ? `/ui/rollups?asset=${asset}&limit=50`
                : '/ui/rollups?limit=50';
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                setRollups(data);
            }
        } catch (err) {
            console.error('Failed to load 1-minute rollups:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchRollups(filterReactor);
        const interval = setInterval(() => {
            fetchRollups(filterReactor);
        }, 10000); // 10s auto-refresh for continuous aggregate updates
        return () => clearInterval(interval);
    }, [filterReactor, fetchRollups]);

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

    const formatUnit = (u) => {
        if (!u) return '—';
        if (u === 'degC') return '°C';
        if (u === 'degC/h') return '°C/h';
        if (u === 'bar g') return 'bar';
        return u;
    };

    return (
        <div className="panel rollup-audit-panel" >
            {/* Filter & Refresh Toolbar */}
            <div className="rollup-toolbar">
                <div className="rollup-title-grp">
                    <span className="rollup-title">1-Min Rollups</span>
                    <span className="rollup-subtitle">TimescaleDB continuous aggregate</span>
                </div>

                <div className="rollup-controls">
                    <div className="vessel-filter-grp" role="group" aria-label="Filter rollups by reactor">
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
                    <button
                        type="button"
                        className="btn-refresh"
                        onClick={() => fetchRollups(filterReactor)}
                        title="Refresh continuous aggregates now">
                        {loading ? '⟳…' : '⟳ Refresh'}
                    </button>
                </div>
            </div>

            {/* Rollup Data Table */}
            <div className="rollup-table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th style={{ width: '65px' }}>Time</th>
                            <th style={{ width: '50px' }}>Reactor</th>
                            <th>Parameter Description</th>
                            <th style={{ width: '45px' }}>Unit</th>
                            <th style={{ textAlign: 'right', width: '70px' }}>Average</th>
                            <th style={{ textAlign: 'right', width: '60px' }}>Min</th>
                            <th style={{ textAlign: 'right', width: '60px' }}>Max</th>
                            <th style={{ textAlign: 'right', width: '125px' }}>% Good Points</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rollups.length === 0 ? (
                            <tr>
                                <td colSpan="8" className="rollup-empty">
                                    {loading ? 'Fetching rollups from TimescaleDB…' : `No 1-minute rollup records found for ${filterReactor}`}
                                </td>
                            </tr>
                        ) : (
                            rollups.map((r, idx) => {
                                const pct = Number(r.pct_good);
                                const is100 = pct >= 99.9;
                                const isWarning = pct >= 80 && pct < 99.9;
                                const isAlarm = pct < 80;

                                const badgeClass = is100 ? 'good' : isWarning ? 'caution' : 'alarm';

                                return (
                                    <tr key={`${r.time}-${r.tag}-${idx}`}>
                                        <td className="mono muted">{formatTime(r.time)}</td>
                                        <td>
                                            <span className="vessel-badge">{r.reactor}</span>
                                        </td>
                                        <td className="tag-desc-cell" title={r.tag}>
                                            <span className="tag-desc-title">{r.description || r.tag}</span>
                                        </td>
                                        <td className="mono muted" title={r.unit || ''}>
                                            {formatUnit(r.unit)}
                                        </td>
                                        <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
                                            {r.avg !== null ? r.avg : '—'}
                                        </td>
                                        <td className="mono muted" style={{ textAlign: 'right' }}>
                                            {r.min !== null ? r.min : '—'}
                                        </td>
                                        <td className="mono muted" style={{ textAlign: 'right' }}>
                                            {r.max !== null ? r.max : '—'}
                                        </td>
                                        <td style={{ textAlign: 'right' }}>
                                            <span className={`quality-ratio-pill ${badgeClass}`}>
                                                <i className="quality-dot" />
                                                <b>{pct.toFixed(1)}%</b>
                                                <span className="ratio-count">({r.good_points}/{r.total_points})</span>
                                            </span>
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