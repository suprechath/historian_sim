import React, { useState, useEffect, useCallback, useMemo } from 'react';

// Case type descriptors
const CASE_TYPES = {
    1: { name: 'Single Step', desc: 'Direct single-step execution on demand' },
    2: { name: 'Step End', desc: 'Continuous polling awaiting stage step completion' },
    3: { name: 'Interval Profile', desc: 'Periodic sampling and profile series transmission' },
    4: { name: 'Event Trigger', desc: 'Awaiting upstream DCS / Batch event timestamp' }
};

function formatIso(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
        `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}

function formatTimeOnly(dateObj) {
    if (!dateObj) return '—';
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}

function formatRelativeCountdown(scheduledTimeStr) {
    if (!scheduledTimeStr) return '—';
    const target = new Date(scheduledTimeStr).getTime();
    const now = Date.now();
    const diffSec = Math.round((target - now) / 1000);

    if (diffSec < -60) {
        const mins = Math.floor(Math.abs(diffSec) / 60);
        return { text: `${mins}m overdue`, isOverdue: true, isDueNow: false };
    }
    if (diffSec < 0) {
        return { text: `${Math.abs(diffSec)}s overdue`, isOverdue: true, isDueNow: false };
    }
    if (diffSec <= 3) {
        return { text: 'Due now', isOverdue: false, isDueNow: true };
    }
    if (diffSec < 60) {
        return { text: `in ${diffSec}s`, isOverdue: false, isDueNow: false };
    }
    const mins = Math.floor(diffSec / 60);
    const remSec = diffSec % 60;
    return { text: `in ${mins}m ${remSec}s`, isOverdue: false, isDueNow: false };
}

export default function ScheduledTasks({ stream, onNavigate }) {
    // Data state
    const [tasks, setTasks] = useState([]);
    const [totalMatching, setTotalMatching] = useState(0);
    const [summary, setSummary] = useState({
        pendingCount: 0,
        processingCount: 0,
        completed24hCount: 0,
        failed24hCount: 0,
        cancelled24hCount: 0,
        totalAllTime: 0,
        earliestPendingTime: null
    });
    const [loading, setLoading] = useState(false);
    const [lastFetched, setLastFetched] = useState(null);

    // Filter & control state
    // Default is 'pending' -> Completed or Cancelled tasks are absent!
    const [statusFilter, setStatusFilter] = useState('pending');
    const [caseTypeFilter, setCaseTypeFilter] = useState('ALL');
    const [searchQuery, setSearchQuery] = useState('');
    const [autoRefreshInterval, setAutoRefreshInterval] = useState(3); // 3 seconds default
    const [actionLoadingId, setActionLoadingId] = useState(null);
    const [toast, setToast] = useState(null);

    // Modal state
    const [inspectTask, setInspectTask] = useState(null);
    const [cancelModalTask, setCancelModalTask] = useState(null);
    const [cancelReason, setCancelReason] = useState('Cancelled by operator via UI');
    const [copiedId, setCopiedId] = useState(false);

    // Toast auto-clear
    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(timer);
    }, [toast]);

    const showToast = (message, type = 'success') => {
        setToast({ message, type });
    };

    // Fetch tasks from API
    const fetchTasks = useCallback(async (isSilent = false) => {
        if (!isSilent) setLoading(true);
        try {
            const params = new URLSearchParams();
            if (statusFilter !== 'all') {
                params.set('status', statusFilter);
            } else {
                params.set('status', 'all');
            }

            if (caseTypeFilter !== 'ALL') {
                params.set('caseType', caseTypeFilter);
            }

            if (searchQuery.trim()) {
                params.set('search', searchQuery.trim());
            }

            params.set('limit', '100');

            const res = await fetch(`/ui/scheduled-instructions?${params.toString()}`);
            if (res.ok) {
                const data = await res.json();
                setTasks(data.tasks || []);
                setTotalMatching(data.totalMatching || 0);
                if (data.summary) {
                    setSummary(data.summary);
                }
                setLastFetched(new Date());
            } else {
                const errData = await res.json().catch(() => ({}));
                console.error('Fetch scheduled instructions failed:', errData.error || res.statusText);
            }
        } catch (err) {
            console.error('Error fetching scheduled instructions:', err);
        } finally {
            if (!isSilent) setLoading(false);
        }
    }, [statusFilter, caseTypeFilter, searchQuery]);

    // Initial load and filter change trigger
    useEffect(() => {
        fetchTasks(false);
    }, [fetchTasks]);

    // Auto-refresh interval
    useEffect(() => {
        if (autoRefreshInterval <= 0) return;
        const interval = setInterval(() => {
            fetchTasks(true);
        }, autoRefreshInterval * 1000);
        return () => clearInterval(interval);
    }, [autoRefreshInterval, fetchTasks]);

    // Also trigger instant fetch when stream reports a change in pendingScheduledCount
    useEffect(() => {
        if (stream?.pendingScheduledCount !== undefined) {
            fetchTasks(true);
        }
    }, [stream?.pendingScheduledCount, fetchTasks]);

    // Handle cancel task
    const handleConfirmCancel = async () => {
        if (!cancelModalTask) return;
        const taskId = cancelModalTask.id;
        setActionLoadingId(taskId);

        try {
            const res = await fetch(`/ui/scheduled-instructions/${taskId}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: cancelReason })
            });

            if (res.ok) {
                showToast(`Task ${cancelModalTask.ref_instruction} for batch ${cancelModalTask.batch_id} cancelled.`, 'info');
                setCancelModalTask(null);
                if (inspectTask?.id === taskId) {
                    setInspectTask(null);
                }
                // Refresh list immediately (the cancelled task will disappear if in pending view!)
                fetchTasks(true);
            } else {
                const data = await res.json();
                showToast(data.error || 'Failed to cancel task', 'error');
            }
        } catch (err) {
            showToast('Network error while cancelling task', 'error');
        } finally {
            setActionLoadingId(null);
        }
    };

    // Handle trigger now
    const handleTriggerNow = async (task) => {
        setActionLoadingId(task.id);
        try {
            const res = await fetch(`/ui/scheduled-instructions/${task.id}/trigger-now`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (res.ok) {
                showToast(`Task ${task.ref_instruction} scheduled for immediate execution.`, 'success');
                if (inspectTask?.id === task.id) {
                    setInspectTask((prev) => ({ ...prev, scheduled_time: new Date().toISOString() }));
                }
                fetchTasks(true);
            } else {
                const data = await res.json();
                showToast(data.error || 'Failed to trigger task', 'error');
            }
        } catch (err) {
            showToast('Network error while triggering task', 'error');
        } finally {
            setActionLoadingId(null);
        }
    };

    const handleCopyJson = (payload) => {
        try {
            navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
            setCopiedId(true);
            setTimeout(() => setCopiedId(false), 2000);
        } catch (err) {
            console.error('Clipboard copy failed:', err);
        }
    };

    // Next scheduled countdown text
    const nextDueInfo = useMemo(() => {
        if (!summary.earliestPendingTime) return 'Queue idle';
        const cd = formatRelativeCountdown(summary.earliestPendingTime);
        return cd.text;
    }, [summary.earliestPendingTime]);

    return (
        <main className="scheduled-tasks-main">
            {/* Toast notification banner */}
            {toast && (
                <div className={`scheduled-toast ${toast.type}`}>
                    <span className="toast-dot" />
                    <span className="toast-msg">{toast.message}</span>
                    <button className="toast-close" onClick={() => setToast(null)}>&times;</button>
                </div>
            )}

            {/* Breadcrumb & Sub-header */}
            <div className="scheduled-page-header">
                <div className="header-breadcrumbs">
                    <button
                        type="button"
                        className="breadcrumb-back-btn"
                        onClick={() => onNavigate && onNavigate('overview')}
                        title="Back to Process Mimic Overview"
                    >
                        ← Process Mimic
                    </button>
                    <span className="breadcrumb-separator">/</span>
                    <span className="breadcrumb-current">Scheduled Tasks Queue</span>
                </div>

                <div className="header-meta-actions">
                    <div className="header-sync-status">
                        <span className={`sync-beacon ${autoRefreshInterval > 0 ? 'active' : 'paused'}`} />
                        <span className="sync-text">
                            {autoRefreshInterval > 0 ? `Auto-refresh ${autoRefreshInterval}s` : 'Paused'}
                        </span>
                        {lastFetched && (
                            <span className="sync-time" title="Last synchronized time">
                                · Synced {formatTimeOnly(lastFetched)}
                            </span>
                        )}
                    </div>

                    <div className="refresh-rate-picker" role="group" aria-label="Auto-refresh speed">
                        {[
                            { label: '2s', val: 2 },
                            { label: '3s', val: 3 },
                            { label: '5s', val: 5 },
                            { label: '10s', val: 10 },
                            { label: 'Off', val: 0 }
                        ].map((item) => (
                            <button
                                key={item.val}
                                type="button"
                                className={`refresh-rate-btn ${autoRefreshInterval === item.val ? 'active' : ''}`}
                                onClick={() => setAutoRefreshInterval(item.val)}
                                title={item.val === 0 ? 'Pause auto-refresh' : `Refresh every ${item.val} seconds`}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>

                    <button
                        type="button"
                        className="btn-manual-refresh"
                        onClick={() => fetchTasks(false)}
                        title="Refresh scheduled instructions from database now"
                    >
                        {loading ? '⟳ Loading…' : '⟳ Refresh'}
                    </button>

                    <a
                        href="/adminer/?pgsql=timescaledb&username=admin&db=reactor&table=scheduled_instructions"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-adminer-link"
                        title="Open scheduled_instructions table directly in Adminer"
                    >
                        <svg className="adminer-svg" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M4 1h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2zm0 1a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H4z"/>
                            <path d="M8 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0 1a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/>
                        </svg>
                        <span>Adminer ↗</span>
                    </a>
                </div>
            </div>

            {/* Top KPI Metric Cards */}
            <div className="scheduled-kpi-grid">
                <div className={`scheduled-kpi-card ${summary.pendingCount > 0 ? 'pending-active' : 'idle'}`}>
                    <div className="kpi-card-header">
                        <span className="kpi-icon-pill pending">
                            <span className={`kpi-beacon ${summary.pendingCount > 0 ? 'pulse' : ''}`} />
                            Active Pending Queue
                        </span>
                        <span className="kpi-badge-hint">Current View</span>
                    </div>
                    <div className="kpi-card-body">
                        <span className="kpi-number">{summary.pendingCount}</span>
                        <span className="kpi-label">
                            {summary.pendingCount === 1 ? 'task awaiting trigger' : 'tasks awaiting trigger'}
                        </span>
                    </div>
                    <div className="kpi-card-footer">
                        Completed & cancelled tasks are filtered out automatically
                    </div>
                </div>

                <div className="scheduled-kpi-card">
                    <div className="kpi-card-header">
                        <span className="kpi-icon-pill time">
                            <svg className="kpi-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                                <circle cx="8" cy="8" r="6" />
                                <polyline points="8 4.5 8 8 10.5 9.5" />
                            </svg>
                            Next Scheduled Run
                        </span>
                    </div>
                    <div className="kpi-card-body">
                        <span className="kpi-number text-highlight">{nextDueInfo}</span>
                        <span className="kpi-label">
                            {summary.earliestPendingTime ? formatIso(summary.earliestPendingTime) : 'No instructions pending'}
                        </span>
                    </div>
                    <div className="kpi-card-footer">
                        Worker claims due tasks every continuous tick
                    </div>
                </div>

                <div className="scheduled-kpi-card">
                    <div className="kpi-card-header">
                        <span className="kpi-icon-pill completed">
                            <svg className="kpi-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 8.5 6.5 12 13 4.5" />
                            </svg>
                            Completed (24h)
                        </span>
                    </div>
                    <div className="kpi-card-body">
                        <span className="kpi-number text-success">{summary.completed24hCount}</span>
                        <span className="kpi-label">dispatched & executed</span>
                    </div>
                    <div className="kpi-card-footer">
                        Acknowledged by BatchLine integration
                    </div>
                </div>

                <div className="scheduled-kpi-card">
                    <div className="kpi-card-header">
                        <span className="kpi-icon-pill cancelled">
                            <svg className="kpi-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                                <line x1="4" y1="4" x2="12" y2="12" />
                                <line x1="12" y1="4" x2="4" y2="12" />
                            </svg>
                            Cancelled / Failed (24h)
                        </span>
                    </div>
                    <div className="kpi-card-body">
                        <span className="kpi-number text-muted">
                            {summary.cancelled24hCount} <small className="kpi-sub-num">({summary.failed24hCount} failed)</small>
                        </span>
                        <span className="kpi-label">superseded or terminated</span>
                    </div>
                    <div className="kpi-card-footer">
                        Audit trail kept in PostgreSQL database
                    </div>
                </div>
            </div>

            {/* Filter Toolbar & Search */}
            <div className="scheduled-toolbar-panel">
                <div className="status-tabs-group" role="tablist" aria-label="Filter tasks by status">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={statusFilter === 'pending'}
                        className={`status-tab-btn ${statusFilter === 'pending' ? 'active' : ''}`}
                        onClick={() => setStatusFilter('pending')}
                    >
                        <span className="tab-status-dot pending" />
                        <span>Pending Tasks</span>
                        <span className="tab-count-pill">{summary.pendingCount}</span>
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={statusFilter === 'completed'}
                        className={`status-tab-btn ${statusFilter === 'completed' ? 'active' : ''}`}
                        onClick={() => setStatusFilter('completed')}
                    >
                        <span className="tab-status-dot completed" />
                        <span>Completed</span>
                        <span className="tab-count-pill">{summary.completed24hCount}</span>
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={statusFilter === 'cancelled'}
                        className={`status-tab-btn ${statusFilter === 'cancelled' ? 'active' : ''}`}
                        onClick={() => setStatusFilter('cancelled')}
                    >
                        <span className="tab-status-dot cancelled" />
                        <span>Cancelled</span>
                        <span className="tab-count-pill">{summary.cancelled24hCount}</span>
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={statusFilter === 'failed'}
                        className={`status-tab-btn ${statusFilter === 'failed' ? 'active' : ''}`}
                        onClick={() => setStatusFilter('failed')}
                    >
                        <span className="tab-status-dot failed" />
                        <span>Failed</span>
                        <span className="tab-count-pill">{summary.failed24hCount}</span>
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={statusFilter === 'all'}
                        className={`status-tab-btn ${statusFilter === 'all' ? 'active' : ''}`}
                        onClick={() => setStatusFilter('all')}
                    >
                        <span>All History</span>
                        <span className="tab-count-pill">{summary.totalAllTime}</span>
                    </button>
                </div>

                <div className="toolbar-controls-row">
                    <div className="case-filter-select-wrap">
                        <label htmlFor="case-type-select" className="filter-label">Case Type:</label>
                        <select
                            id="case-type-select"
                            className="toolbar-select"
                            value={caseTypeFilter}
                            onChange={(e) => setCaseTypeFilter(e.target.value)}
                        >
                            <option value="ALL">All Case Types</option>
                            <option value="1">Case 1 · Single Step</option>
                            <option value="2">Case 2 · Step End</option>
                            <option value="3">Case 3 · Interval Profile</option>
                            <option value="4">Case 4 · Event Trigger</option>
                        </select>
                    </div>

                    <div className="search-input-wrap">
                        <svg className="search-svg" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                        </svg>
                        <input
                            type="text"
                            className="toolbar-search-input"
                            placeholder="Search by Batch ID, Ref, or keyword…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                className="search-clear-btn"
                                onClick={() => setSearchQuery('')}
                                title="Clear search"
                            >
                                &times;
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Instruction Queue Data Table */}
            <div className="panel scheduled-table-panel">
                <div className="table-responsive">
                    <table className="scheduled-data-table">
                        <thead>
                            <tr>
                                <th style={{ width: '110px' }}>Status</th>
                                <th style={{ width: '160px' }}>Scheduled For</th>
                                <th style={{ width: '150px' }}>Target Batch</th>
                                <th style={{ width: '100px' }}>Ref Instruction</th>
                                <th style={{ width: '145px' }}>Case Type</th>
                                <th style={{ width: '85px', textAlign: 'center' }}>Attempts</th>
                                <th>Payload Context</th>
                                <th>Status Note / Error</th>
                                <th style={{ width: '140px', textAlign: 'right' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tasks.length === 0 ? (
                                <tr>
                                    <td colSpan="9">
                                        <div className="scheduled-empty-state">
                                            {loading ? (
                                                <div className="empty-loading-spinner">
                                                    <span className="spinner-icon" />
                                                    <p>Querying scheduled_instructions table…</p>
                                                </div>
                                            ) : statusFilter === 'pending' ? (
                                                <div className="empty-content-box">
                                                    <div className="empty-icon-shield">✓</div>
                                                    <h3>No Pending Scheduled Tasks</h3>
                                                    <p>
                                                        All scheduled instructions have been executed or cancelled.
                                                        Completed and cancelled instructions are absent from this active view.
                                                    </p>
                                                    <div className="empty-actions">
                                                        <button
                                                            type="button"
                                                            className="btn-empty-switch"
                                                            onClick={() => setStatusFilter('all')}
                                                        >
                                                            View All Task History ({summary.totalAllTime})
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="empty-content-box">
                                                    <p>No records found matching current status filter: <b>{statusFilter.toUpperCase()}</b></p>
                                                    <button
                                                        type="button"
                                                        className="btn-empty-switch"
                                                        onClick={() => {
                                                            setStatusFilter('pending');
                                                            setCaseTypeFilter('ALL');
                                                            setSearchQuery('');
                                                        }}
                                                    >
                                                        Reset Filters
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                tasks.map((task) => {
                                    const caseInfo = CASE_TYPES[task.case_type] || { name: `Case ${task.case_type}`, desc: 'Custom Handler' };
                                    const cd = formatRelativeCountdown(task.scheduled_time);
                                    const isPending = task.status === 'pending';
                                    const payloadCtx = task.payload?.ctx || task.payload || {};
                                    const refEvent = task.payload?.refEvent || payloadCtx.rawBody?.Data?.Batch?.Phase?.Step?.Instruction?.RefEvent || '—';
                                    const refType = task.payload?.refType || payloadCtx.rawBody?.Data?.Batch?.Phase?.Step?.Instruction?.RefType || '—';

                                    return (
                                        <tr
                                            key={task.id}
                                            className={`scheduled-row ${isPending ? 'row-pending' : 'row-settled'}`}
                                            onClick={() => setInspectTask(task)}
                                        >
                                            {/* Status */}
                                            <td>
                                                <span className={`task-status-pill ${task.status}`}>
                                                    <span className={`status-dot ${isPending ? 'pulsing' : ''}`} />
                                                    {task.status.toUpperCase()}
                                                </span>
                                            </td>

                                            {/* Scheduled Time */}
                                            <td>
                                                <div className="scheduled-time-cell">
                                                    <span className={`countdown-tag ${cd.isOverdue ? 'overdue' : cd.isDueNow ? 'due-now' : 'normal'}`}>
                                                        {cd.text}
                                                    </span>
                                                    <span className="mono-sub-time" title={formatIso(task.scheduled_time)}>
                                                        {formatTimeOnly(task.scheduled_time)}
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Target Batch */}
                                            <td>
                                                <span className="mono-batch-badge" title={`Batch ID: ${task.batch_id || 'Global'}`}>
                                                    {task.batch_id || '—'}
                                                </span>
                                            </td>

                                            {/* Ref Instruction */}
                                            <td>
                                                <span className="mono-ref-badge" title="Reference Instruction Tag">
                                                    {task.ref_instruction}
                                                </span>
                                            </td>

                                            {/* Case Type */}
                                            <td>
                                                <span className={`case-type-badge case-${task.case_type}`} title={caseInfo.desc}>
                                                    Case {task.case_type} · {caseInfo.name}
                                                </span>
                                            </td>

                                            {/* Attempts */}
                                            <td style={{ textAlign: 'center' }}>
                                                <span className={`mono-attempts ${task.attempts > 0 ? 'has-retries' : ''}`}>
                                                    {task.attempts} / {task.max_attempts}
                                                </span>
                                            </td>

                                            {/* Payload Context */}
                                            <td>
                                                <div className="payload-context-excerpt" title="Click row to inspect full JSON payload">
                                                    <span className="payload-event-tag">{refEvent}</span>
                                                    <span className="payload-type-tag">({refType})</span>
                                                    <span className="btn-inspect-pill">Inspect ↗</span>
                                                </div>
                                            </td>

                                            {/* Status Note / Error */}
                                            <td>
                                                <div className="error-note-cell" title={task.last_error || 'No errors logged'}>
                                                    {task.last_error ? (
                                                        <span className="note-text-err">{task.last_error}</span>
                                                    ) : (
                                                        <span className="note-text-clean">—</span>
                                                    )}
                                                </div>
                                            </td>

                                            {/* Actions */}
                                            <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                                                <div className="row-actions-group">
                                                    {isPending ? (
                                                        <>
                                                            <button
                                                                type="button"
                                                                className="btn-action-trigger"
                                                                onClick={() => handleTriggerNow(task)}
                                                                disabled={actionLoadingId === task.id}
                                                                title="Trigger immediate execution (sets scheduled_time = NOW)"
                                                            >
                                                                {actionLoadingId === task.id ? '…' : '⚡ Run Now'}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="btn-action-cancel"
                                                                onClick={() => {
                                                                    setCancelModalTask(task);
                                                                    setCancelReason('Cancelled by operator via UI');
                                                                }}
                                                                disabled={actionLoadingId === task.id}
                                                                title="Cancel pending instruction"
                                                            >
                                                                ✕ Cancel
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            className="btn-action-view"
                                                            onClick={() => setInspectTask(task)}
                                                        >
                                                            View
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="table-footer-status">
                    <span>
                        Showing <b>{tasks.length}</b> of <b>{totalMatching}</b> records matching status <b>{statusFilter.toUpperCase()}</b>
                    </span>
                    {statusFilter === 'pending' && (
                        <span className="footer-absent-hint">
                            * Completed and cancelled instructions are absent from this view.
                        </span>
                    )}
                </div>
            </div>

            {/* Inspect Payload Modal */}
            {inspectTask && (
                <div className="scheduled-modal-backdrop" onClick={() => setInspectTask(null)}>
                    <div className="scheduled-modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
                        <div className="modal-card-header">
                            <div className="modal-header-title">
                                <span className={`modal-status-beacon ${inspectTask.status}`} />
                                <h3>Scheduled Instruction Details</h3>
                                <span className="modal-ref-tag">{inspectTask.ref_instruction}</span>
                            </div>
                            <button
                                type="button"
                                className="modal-close-btn"
                                onClick={() => setInspectTask(null)}
                                title="Close dialog"
                            >
                                &times;
                            </button>
                        </div>

                        <div className="modal-card-body">
                            {/* Key Metadata Grid */}
                            <div className="modal-meta-grid">
                                <div className="meta-item">
                                    <span className="meta-label">Task UUID</span>
                                    <span className="meta-val mono">
                                        {inspectTask.id}
                                        <button
                                            type="button"
                                            className="meta-copy-btn"
                                            onClick={() => handleCopyJson(inspectTask.id)}
                                            title="Copy task ID"
                                        >
                                            Copy
                                        </button>
                                    </span>
                                </div>
                                <div className="meta-item">
                                    <span className="meta-label">Batch ID</span>
                                    <span className="meta-val mono">{inspectTask.batch_id || 'Global'}</span>
                                </div>
                                <div className="meta-item">
                                    <span className="meta-label">Case Type</span>
                                    <span className="meta-val">
                                        Case {inspectTask.case_type} ({CASE_TYPES[inspectTask.case_type]?.name || 'Custom'})
                                    </span>
                                </div>
                                <div className="meta-item">
                                    <span className="meta-label">Current Status</span>
                                    <span className={`meta-val task-status-pill ${inspectTask.status}`}>
                                        {inspectTask.status.toUpperCase()}
                                    </span>
                                </div>
                                <div className="meta-item">
                                    <span className="meta-label">Scheduled Execution</span>
                                    <span className="meta-val">{formatIso(inspectTask.scheduled_time)}</span>
                                </div>
                                <div className="meta-item">
                                    <span className="meta-label">Created At</span>
                                    <span className="meta-val">{formatIso(inspectTask.created_at)}</span>
                                </div>
                                {inspectTask.executed_at && (
                                    <div className="meta-item">
                                        <span className="meta-label">Settled / Executed At</span>
                                        <span className="meta-val">{formatIso(inspectTask.executed_at)}</span>
                                    </div>
                                )}
                                <div className="meta-item">
                                    <span className="meta-label">Attempts Made</span>
                                    <span className="meta-val mono">{inspectTask.attempts} of {inspectTask.max_attempts} max</span>
                                </div>
                            </div>

                            {/* Error or Last Note */}
                            {inspectTask.last_error && (
                                <div className="modal-error-box">
                                    <span className="error-box-title">Last Note / System Output:</span>
                                    <p className="error-box-text">{inspectTask.last_error}</p>
                                </div>
                            )}

                            {/* Raw JSON Payload Viewer */}
                            <div className="modal-json-section">
                                <div className="json-section-header">
                                    <span>Instruction Payload JSON</span>
                                    <button
                                        type="button"
                                        className="btn-copy-json"
                                        onClick={() => handleCopyJson(inspectTask.payload)}
                                    >
                                        {copiedId ? '✓ Copied' : 'Copy JSON'}
                                    </button>
                                </div>
                                <pre className="modal-json-block">
                                    <code>{JSON.stringify(inspectTask.payload, null, 2)}</code>
                                </pre>
                            </div>
                        </div>

                        <div className="modal-card-footer">
                            {inspectTask.status === 'pending' && (
                                <>
                                    <button
                                        type="button"
                                        className="btn-modal-trigger"
                                        onClick={() => handleTriggerNow(inspectTask)}
                                        disabled={actionLoadingId === inspectTask.id}
                                    >
                                        ⚡ Trigger Immediately
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-modal-cancel"
                                        onClick={() => {
                                            setCancelModalTask(inspectTask);
                                            setCancelReason('Cancelled by operator via UI');
                                        }}
                                        disabled={actionLoadingId === inspectTask.id}
                                    >
                                        ✕ Cancel Task
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                className="btn-modal-dismiss"
                                onClick={() => setInspectTask(null)}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Cancel Confirmation Modal */}
            {cancelModalTask && (
                <div className="scheduled-modal-backdrop" onClick={() => setCancelModalTask(null)}>
                    <div className="scheduled-modal-card confirm-cancel-card" onClick={(e) => e.stopPropagation()} role="alertdialog">
                        <div className="modal-card-header">
                            <h3>Confirm Cancellation</h3>
                            <button
                                type="button"
                                className="modal-close-btn"
                                onClick={() => setCancelModalTask(null)}
                            >
                                &times;
                            </button>
                        </div>

                        <div className="modal-card-body">
                            <p className="confirm-prompt">
                                Are you sure you want to cancel the scheduled instruction{' '}
                                <b>[{cancelModalTask.ref_instruction}]</b> for batch{' '}
                                <b>{cancelModalTask.batch_id || 'Global'}</b>?
                            </p>
                            <p className="confirm-sub-prompt">
                                Once cancelled, the task status becomes <b>cancelled</b> and it will be absent from the active pending queue.
                            </p>

                            <div className="cancel-reason-input-group">
                                <label htmlFor="cancel-reason-field">Reason for Cancellation:</label>
                                <input
                                    id="cancel-reason-field"
                                    type="text"
                                    className="toolbar-search-input"
                                    value={cancelReason}
                                    onChange={(e) => setCancelReason(e.target.value)}
                                    placeholder="Enter cancellation reason…"
                                />
                            </div>
                        </div>

                        <div className="modal-card-footer">
                            <button
                                type="button"
                                className="btn-modal-dismiss"
                                onClick={() => setCancelModalTask(null)}
                            >
                                Keep Task
                            </button>
                            <button
                                type="button"
                                className="btn-modal-cancel confirm-btn"
                                onClick={handleConfirmCancel}
                                disabled={actionLoadingId === cancelModalTask.id}
                            >
                                {actionLoadingId === cancelModalTask.id ? 'Cancelling…' : 'Yes, Cancel Instruction'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
}

