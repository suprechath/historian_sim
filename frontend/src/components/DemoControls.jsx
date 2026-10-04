import React, { useState, useEffect } from 'react';

export default function DemoControls({
    selectedReactor,
    onSelectReactor,
    mode = 'continuous',
    assignedBatchId = null,
    singleBatchStatus = 'idle',
    running = true,
    speed = 1,
    reactors = {}
}) {
    const [panelTab, setPanelTab] = useState('batch'); // 'batch' | 'faults'
    const [batchInput, setBatchInput] = useState('');
    const [startImmediate, setStartImmediate] = useState(true);
    const [clearTrain, setClearTrain] = useState(false);
    const [actionMsg, setActionMsg] = useState(null); // { type: 'success' | 'error', text: '' }
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [faults, setFaults] = useState([]);

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
                    startImmediately,
                    clearTrain,
                    resume
                })
            });
            const data = await res.json();
            if (!res.ok) {
                setActionMsg({ type: 'error', text: data.error || 'Failed to assign batch' });
            } else {
                setActionMsg({
                    type: 'success',
                    text: resume
                        ? `Batch ${data.assignedBatchId} assigned & simulation resumed!`
                        : `Batch ${data.assignedBatchId} assigned to R1. Simulator set to single-batch mode.`
                });
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
                body: JSON.stringify({ tag, kind, magnitude: kind === 'drift' ? 200 : 1.5 })
            });
        }
        fetchFaults();
    };

    const clearAllFaults = async () => {
        await fetch('/ui/faults', { method: 'DELETE' });
        fetchFaults();
    };

    const skipPhase = async () => {
        await fetch('/ui/simulation/phase/skip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ asset: selectedReactor })
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
                        ⚡ Faults & Phase
                    </button>
                </div>
                <span className="demo-col-badge">
                    {panelTab === 'batch' ? (mode === 'single' ? 'Single' : 'Cont.') : `${selectedReactor}`}
                </span>
            </div>

            <div className="demo-col-body">
                {panelTab === 'batch' ? (
                    /* ---------------- BATCH CONTROL PANEL ---------------- */
                    <div className="batch-ctrl-container">
                        {/* Mode Switcher */}
                        <div className="batch-mode-selector">
                            <span className="batch-selector-label">Mode:</span>
                            <div className="batch-mode-toggle-group">
                                <button
                                    type="button"
                                    className={`mode-toggle-btn ${mode === 'continuous' ? 'active' : ''}`}
                                    onClick={handleSwitchContinuous}
                                    disabled={isSubmitting}
                                    title="Automatic uninterrupted multi-batch simulation">
                                    🔄 Continuous
                                </button>
                                <button
                                    type="button"
                                    className={`mode-toggle-btn ${mode === 'single' ? 'active' : ''}`}
                                    onClick={() => {}}
                                    title="Produce only one user-assigned batch and stop">
                                    🎯 Single Batch
                                </button>
                            </div>
                        </div>

                        {/* Custom Batch Form */}
                        <div className="batch-form-box">
                            <div className="batch-input-label-row">
                                <label htmlFor="custom-batch-input">Assign Desired Batch #:</label>
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
                                            handleAssignBatch(!running);
                                        }
                                    }}
                                    placeholder="e.g. B-2026-9999 or 42"
                                    disabled={isSubmitting}
                                />
                            </div>

                            <label className="batch-check-label">
                                <input
                                    type="checkbox"
                                    checked={startImmediate}
                                    onChange={(e) => setStartImmediate(e.target.checked)}
                                />
                                <span>Start immediately in R1 (aborts prior batch)</span>
                            </label>

                            <label className="batch-check-label">
                                <input
                                    type="checkbox"
                                    checked={clearTrain}
                                    onChange={(e) => setClearTrain(e.target.checked)}
                                />
                                <span>Line clearance (reset downstream R2 & R3 to Idle)</span>
                            </label>

                            {/* Pause Awareness and Actions */}
                            {!running ? (
                                <div className="batch-paused-actions">
                                    <div className="batch-pause-alert">
                                        <span className="alert-dot" /> Simulator is paused
                                    </div>
                                    <div className="batch-btn-duo">
                                        <button
                                            type="button"
                                            className="demo-pill-btn batch-primary-btn"
                                            onClick={() => handleAssignBatch(true)}
                                            disabled={isSubmitting}
                                            title="Assign batch and resume simulator immediately">
                                            <span className="btn-icon">▶</span>
                                            <span className="btn-text">Send & Resume</span>
                                        </button>
                                        <button
                                            type="button"
                                            className="demo-pill-btn batch-secondary-btn"
                                            onClick={() => handleAssignBatch(false)}
                                            disabled={isSubmitting}
                                            title="Assign batch into R1 but leave simulator paused">
                                            <span className="btn-icon">⏸</span>
                                            <span className="btn-text">Send (Stay Paused)</span>
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    className="demo-pill-btn batch-primary-btn"
                                    onClick={() => handleAssignBatch(false)}
                                    disabled={isSubmitting}>
                                    <span className="btn-icon">🚀</span>
                                    <span className="btn-text">Produce Assigned Batch</span>
                                </button>
                            )}
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
                            <div className="batch-status-header">
                                <span className="status-title">Active Production State</span>
                                <span className={`status-pill ${mode === 'single' ? (singleBatchStatus === 'completed' ? 'pill-completed' : 'pill-single') : 'pill-continuous'}`}>
                                    {mode === 'single'
                                        ? (singleBatchStatus === 'completed' ? '✔ Completed' : '🎯 Single Active')
                                        : '🔄 Continuous Train'}
                                </span>
                            </div>
                            <div className="batch-status-body">
                                {mode === 'single' ? (
                                    <>
                                        <div className="batch-stat-row">
                                            <span className="stat-label">Assigned Batch:</span>
                                            <span className="stat-val mono"><b>{assignedBatchId || 'None'}</b></span>
                                        </div>
                                        <div className="batch-stat-desc">
                                            {singleBatchStatus === 'completed' ? (
                                                <span className="text-ok">Assigned batch finished. Simulator holding idle.</span>
                                            ) : (
                                                <span className="text-info">Simulator will produce only this batch, then stop.</span>
                                            )}
                                        </div>
                                        {mode === 'single' && (
                                            <button
                                                type="button"
                                                className="btn-restore-link"
                                                onClick={handleSwitchContinuous}>
                                                Return to Continuous Mode &rarr;
                                            </button>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <div className="batch-stat-row">
                                            <span className="stat-label">Train Batches:</span>
                                            <span className="stat-val mono">
                                                {reactors.R1?.batchId || 'Idle'} &rarr; {reactors.R2?.batchId || 'Idle'} &rarr; {reactors.R3?.batchId || 'Idle'}
                                            </span>
                                        </div>
                                        <div className="batch-stat-desc">
                                            Auto-generating batches indefinitely.
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Quick Phase Advancer */}
                        <div className="demo-btn-stack" style={{ marginTop: 'auto' }}>
                            <button
                                type="button"
                                className="demo-pill-btn skip-pill-btn"
                                onClick={skipPhase}
                                title={`Advance current batch phase for ${selectedReactor}`}>
                                <span className="skip-icon">⏩</span>
                                <span className="btn-text">Skip {selectedReactor} Phase</span>
                            </button>
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
                                title={`Toggle temperature drift on ${selectedReactor}.TEMP (+1.5°C)`}>
                                <span className={`led-dot ${hasDrift ? 'led-amber' : ''}`} />
                                <span className="btn-text">
                                    {hasDrift ? 'Stop Drift' : 'Start Temp Drift'}
                                </span>
                            </button>
                        </div>

                        {/* Batch Sequencer Action */}
                        <div className="demo-btn-stack">
                            <button
                                type="button"
                                className="demo-pill-btn skip-pill-btn"
                                onClick={skipPhase}
                                title={`Advance current batch phase for ${selectedReactor}`}>
                                <span className="skip-icon">⏩</span>
                                <span className="btn-text">Skip {selectedReactor} Phase</span>
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
        </div>
    );
}