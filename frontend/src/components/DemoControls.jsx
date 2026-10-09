import React, { useState, useEffect } from 'react';

export default function DemoControls({
    selectedReactor,
    onSelectReactor,
    mode = 'continuous',
    assignedBatchId = null,
    singleBatchStatus = 'idle',
    batchQueue = [],
    running = true,
    speed = 1,
    reactors = {}
}) {
    const [panelTab, setPanelTab] = useState('batch'); // 'batch' | 'faults'
    const [batchInput, setBatchInput] = useState('');
    const [startImmediate, setStartImmediate] = useState(false);
    const [resetDownstream, setResetDownstream] = useState(false);
    const [actionMsg, setActionMsg] = useState(null); // { type: 'success' | 'error', text: '' }
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [faults, setFaults] = useState([]);

    const pendingBatches = (batchQueue || []).filter(
        (b) => b.status === 'waiting_r1' || b.status === 'in_queue'
    );

    const fetchFaults = async () => {
        try {
            const res = await fetch('/ui/faults');
            if (res.ok) setFaults(await res.json());
        } catch (err) {
            console.error('Failed to load faults:', err);
        }
    };

    useEffect(() => {
        fetchFaults();
        const interval = setInterval(fetchFaults, 3000);
        return () => clearInterval(interval);
    }, []);

    // Set initial placeholder/suggested batch ID
    useEffect(() => {
        if (!batchInput) {
            const year = new Date().getUTCFullYear();
            const randSuffix = Math.floor(1000 + Math.random() * 9000);
            setBatchInput(`B-${year}-${randSuffix}`);
        }
    }, []);

    const handleAssignBatch = async (resume = false) => {
        if (!batchInput || !batchInput.trim()) {
            setActionMsg({ type: 'error', text: 'Please enter a valid batch number or identifier.' });
            return;
        }

        setIsSubmitting(true);
        setActionMsg(null);
        try {
            const res = await fetch('/ui/simulation/batch/assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batchId: batchInput.trim(),
                    startImmediately: Boolean(startImmediate && !resetDownstream),
                    resetDownstream: Boolean(!startImmediate && resetDownstream),
                    resume
                })
            });
            const data = await res.json();
            if (!res.ok) {
                setActionMsg({ type: 'error', text: data.error || 'Failed to assign batch' });
            } else {
                // Green box message is not needed
                setActionMsg(null);
                setBatchInput('');
            }
        } catch (err) {
            setActionMsg({ type: 'error', text: err.message || 'Connection error' });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleSwitchContinuous = async () => {
        setIsSubmitting(true);
        setActionMsg(null);
        try {
            const res = await fetch('/ui/simulation/batch/continuous', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (res.ok) {
                setActionMsg({ type: 'success', text: 'Resumed continuous auto-production simulation.' });
            } else {
                setActionMsg({ type: 'error', text: data.error || 'Failed to switch mode' });
            }
        } catch (err) {
            setActionMsg({ type: 'error', text: err.message });
        } finally {
            setIsSubmitting(false);
        }
    };

    const hasDropout = faults.some(f => f.tag === `${selectedReactor}.TEMP` && f.kind === 'dropout');
    const hasDrift = faults.some(f => f.tag === `${selectedReactor}.TEMP` && f.kind === 'drift');

    const toggleFault = async (kind) => {
        const tag = `${selectedReactor}.TEMP`;
        const isActive = faults.some(f => f.tag === tag && f.kind === kind);

        if (isActive) {
            await fetch(`/ui/faults?tag=${tag}`, { method: 'DELETE' });
        } else {
            await fetch('/ui/faults', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag, kind, magnitude: kind === 'drift' ? 6.0 : 0 })
            });
        }
        fetchFaults();
    };

    const clearAllFaults = async () => {
        await fetch('/ui/faults', { method: 'DELETE' });
        fetchFaults();
    };

    const skipPhase = async (asset = selectedReactor) => {
        await fetch('/ui/simulation/phase/skip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ asset })
        });
    };

    const skipProcess = async (asset = selectedReactor) => {
        await fetch('/ui/simulation/process/skip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ asset })
        });
    };

    return (
        <div className="panel demo-col-panel">
            {/* Top Navigation Tabs */}
            <div className="demo-col-header">
                <div className="demo-section-tabs" role="tablist">
                    <button
                        type="button"
                        className={`section-tab ${panelTab === 'batch' ? 'active' : ''}`}
                        onClick={() => setPanelTab('batch')}>
                        📦 Batch Control
                    </button>
                    <button
                        type="button"
                        className={`section-tab ${panelTab === 'faults' ? 'active' : ''}`}
                        onClick={() => setPanelTab('faults')}>
                        ⚡ Faults
                    </button>
                </div>
            </div>

            <div className="demo-col-body">
                <div className="demo-tab-content-area">
                    {panelTab === 'batch' ? (
                        /* ---------------- BATCH CONTROL PANEL ---------------- */
                        <div className="batch-ctrl-container">
                            {/* Custom Batch Form */}
                            <div className="batch-form-box">
                                {/* 1. Enter Batch Number */}
                                <div className="batch-input-label-row">
                                    <label htmlFor="custom-batch-input">Batch Number:</label>
                                    <button
                                        type="button"
                                        className="btn-link-preset"
                                        onClick={() => {
                                            const year = new Date().getUTCFullYear();
                                            const randSuffix = Math.floor(1000 + Math.random() * 9000);
                                            setBatchInput(`B-${year}-${randSuffix}`);
                                        }}>
                                        Auto ID
                                    </button>
                                </div>

                                <div className="batch-input-field-wrap">
                                    <input
                                        id="custom-batch-input"
                                        type="text"
                                        className="batch-text-input mono"
                                        value={batchInput}
                                        onChange={(e) => setBatchInput(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                handleAssignBatch();
                                            }
                                        }}
                                        placeholder="e.g. B-2026-1001"
                                        disabled={isSubmitting}
                                    />
                                </div>

                                {/* 2. Start immediately checkbox */}
                                <label className={`batch-check-label ${resetDownstream ? 'disabled' : ''}`}>
                                    <input
                                        type="checkbox"
                                        checked={startImmediate}
                                        disabled={resetDownstream}
                                        onChange={(e) => {
                                            const checked = e.target.checked;
                                            setStartImmediate(checked);
                                            if (checked) {
                                                setResetDownstream(false);
                                            }
                                        }}
                                    />
                                    <span>Start immediately</span>
                                </label>

                                {/* 3. Reset all downstream checkbox (disabled when Start immediately is selected) */}
                                <label className={`batch-check-label ${startImmediate ? 'disabled' : ''}`}>
                                    <input
                                        type="checkbox"
                                        checked={resetDownstream}
                                        disabled={startImmediate}
                                        onChange={(e) => {
                                            const checked = e.target.checked;
                                            setResetDownstream(checked);
                                            if (checked) {
                                                setStartImmediate(false);
                                            }
                                        }}
                                    />
                                    <span>Reset all downstream</span>
                                </label>

                                {/* 4. Assign Batch Button */}
                                <button
                                    type="button"
                                    className="demo-pill-btn batch-primary-btn"
                                    onClick={() => handleAssignBatch()}
                                    disabled={isSubmitting || !batchInput.trim()}
                                    title={!batchInput.trim() ? 'Enter a batch number' : 'Assign batch to simulator'}>
                                    <span className="btn-icon">📋</span>
                                    <span className="btn-text">Assign Batch</span>
                                </button>
                            </div>

                            {/* Inline Feedback Message */}
                            {actionMsg && (
                                <div className={`batch-msg-banner ${actionMsg.type}`}>
                                    <span className="msg-text">{actionMsg.text}</span>
                                    <button type="button" onClick={() => setActionMsg(null)} className="msg-close">
                                        &times;
                                    </button>
                                </div>
                            )}

                            {/* Real-time Status Card */}
                            <div className="batch-status-panel">
                                {/* Manual Batch Request Table */}
                                <div className="batch-status-header">
                                    <span className="status-title" style={{ color: '#000000' }}>Manual Batch Request</span>
                                    <span className={`status-pill ${pendingBatches.length > 0 ? 'pill-single' : 'pill-continuous'}`}>
                                        {pendingBatches.length > 0 ? `${pendingBatches.length} Queued` : '0 Queued'}
                                    </span>
                                </div>

                                <div className="manual-batch-table-wrap">
                                    <table className="manual-batch-table">
                                        <thead>
                                            <tr>
                                                <th style={{ width: '40%', color: '#000000' }}>Batch Number</th>
                                                <th style={{ width: '60%', color: '#000000' }}>Batch status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {pendingBatches.length === 0 ? (
                                                <tr>
                                                    <td colSpan="2" className="empty-batch-cell">
                                                        No pending manual batch requests
                                                    </td>
                                                </tr>
                                            ) : (
                                                pendingBatches.map((item) => (
                                                    <tr key={item.id || item.batchId}>
                                                        <td className="mono batch-id-cell"><b>{item.batchId}</b></td>
                                                        <td className="batch-status-cell">
                                                            {item.status === 'waiting_r1'
                                                                ? 'Wait currect Batch in R1 finished'
                                                                : 'Waits till current batches finished'}
                                                        </td>
                                                    </tr>
                                                ))
                                            )}
                                        </tbody>
                                    </table>
                                </div>

                                {/* Active Batch Status for Each Reactor */}
                                <div className="batch-status-header" style={{ marginTop: '8px' }}>
                                    <span className="status-title" style={{ color: '#000000' }}>Active Batch Status</span>
                                </div>
                                <div className="manual-batch-table-wrap">
                                    <table className="manual-batch-table">
                                        <thead>
                                            <tr>
                                                <th style={{ width: '33.33%', textAlign: 'center', color: '#000000' }}>R1</th>
                                                <th style={{ width: '33.33%', textAlign: 'center', color: '#000000' }}>R2</th>
                                                <th style={{ width: '33.33%', textAlign: 'center', color: '#000000' }}>R3</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr>
                                                <td className="mono batch-id-cell" style={{ textAlign: 'center' }}>
                                                    <b>{reactors?.R1?.batchId || '-'}</b>
                                                </td>
                                                <td className="mono batch-id-cell" style={{ textAlign: 'center' }}>
                                                    <b>{reactors?.R2?.batchId || '-'}</b>
                                                </td>
                                                <td className="mono batch-id-cell" style={{ textAlign: 'center' }}>
                                                    <b>{reactors?.R3?.batchId || '-'}</b>
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    ) : (
                        /* ---------------- FAULTS & PHASE PANEL ---------------- */
                        <div className="faults-ctrl-container">
                            {/* Target Vessel Selector Tabs */}
                            <div className="demo-vessel-tabs-row">
                                <span className="vessel-label">Select Vessel:</span>
                                <div className="demo-vessel-tabs" role="group" aria-label="Target vessel">
                                    {['R1', 'R2', 'R3'].map(r => (
                                        <button
                                            key={r}
                                            type="button"
                                            className={`vessel-tab ${selectedReactor === r ? 'active' : ''}`}
                                            onClick={() => onSelectReactor && onSelectReactor(r)}>
                                            {r}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Fault Triggers */}
                            <div className="demo-btn-stack">
                                <button
                                    type="button"
                                    className={`demo-pill-btn ${hasDropout ? 'fault-active' : ''}`}
                                    onClick={() => toggleFault('dropout')}
                                    title={`Toggle sensor dropout fault on ${selectedReactor}.TEMP`}>
                                    <span className={`led-dot ${hasDropout ? 'led-red' : ''}`} />
                                    <span className="btn-text">
                                        {hasDropout ? 'Recover Sensor' : 'Fail Sensor (Dropout)'}
                                    </span>
                                </button>

                                <button
                                    type="button"
                                    className={`demo-pill-btn ${hasDrift ? 'fault-active' : ''}`}
                                    onClick={() => toggleFault('drift')}
                                    title={`Toggle temperature drift on ${selectedReactor}.TEMP (+6.0°C fault)`}>
                                    <span className={`led-dot ${hasDrift ? 'led-amber' : ''}`} />
                                    <span className="btn-text">
                                        {hasDrift ? 'Stop Drift' : 'Start Temp Drift'}
                                    </span>
                                </button>
                            </div>

                            {/* Bottom Status / Clear Footer */}
                            <div className="demo-col-footer" style={{ marginTop: 'auto' }}>
                                <div className="demo-footer-status">
                                    <span className={`status-indicator ${faults.length > 0 ? 'alarm' : 'ok'}`} />
                                    <span className="status-text">
                                        {faults.length > 0 ? `${faults.length} Fault(s) Active` : 'No Faults'}
                                    </span>
                                </div>
                                {faults.length > 0 && (
                                    <button
                                        type="button"
                                        className="btn-clear-inline"
                                        onClick={clearAllFaults}
                                        title="Clear all injected faults">
                                        Reset All
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Modern Fast-Forward Skip Sequencer Card - Identical position in both tabs */}
                <div className="modern-skip-card">
                    <div className="skip-card-header">
                        <div className="skip-card-title-group">
                            <span className="skip-card-icon">⚡</span>
                            <span className="skip-card-title">Fast-Forward Sequencer</span>
                        </div>
                        <span className="skip-card-badge">Instant Override</span>
                    </div>

                    <table className="modern-skip-table">
                        <thead>
                            <tr>
                                {['R1', 'R2', 'R3'].map(r => (
                                    <th key={`hdr-${r}`}>
                                        <div className={`reactor-col-badge r-${r.toLowerCase()}`}>
                                            <span className="reactor-badge-dot" />
                                            <span className="reactor-badge-name">{r}</span>
                                        </div>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                {['R1', 'R2', 'R3'].map(r => (
                                    <td key={`phase-${r}`}>
                                        <button
                                            type="button"
                                            className="modern-skip-btn btn-skip-phase"
                                            onClick={() => skipPhase(r)}
                                            title={`Advance ${r} to next batch phase`}>
                                            <span className="btn-icon">⏩</span>
                                            <span className="btn-label">Skip Phase</span>
                                        </button>
                                    </td>
                                ))}
                            </tr>
                            <tr>
                                {['R1', 'R2', 'R3'].map(r => (
                                    <td key={`proc-${r}`}>
                                        <button
                                            type="button"
                                            className="modern-skip-btn btn-skip-process"
                                            onClick={() => skipProcess(r)}
                                            title={`Bypass entire ${r} reactor process & transfer out`}>
                                            <span className="btn-icon">⏭️</span>
                                            <span className="btn-label">Skip Process</span>
                                        </button>
                                    </td>
                                ))}
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}