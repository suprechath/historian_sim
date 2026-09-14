import React, { useState, useEffect } from 'react';

export default function DemoControls({ selectedReactor, onSelectReactor }) {
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
            {/* Target Vessel Selector Tabs */}
            <div className="demo-col-header">
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
                <span className="demo-col-badge">TEMP Target</span>
            </div>

            <div className="demo-col-body">
                {/* Fault Triggers */}
                <div className="demo-btn-stack">
                    <button
                        className={`demo-pill-btn ${hasDropout ? 'fault-active' : ''}`}
                        onClick={() => toggleFault('dropout')}
                        title={`Toggle sensor dropout fault on ${selectedReactor}.TEMP`}>
                        <span className={`led-dot ${hasDropout ? 'led-red' : ''}`} />
                        <span className="btn-text">
                            {hasDropout ? 'Recover Sensor' : 'Fail Sensor (Dropout)'}
                        </span>
                    </button>

                    <button
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
                        className="demo-pill-btn skip-pill-btn"
                        onClick={skipPhase}
                        title={`Advance current batch phase for ${selectedReactor}`}>
                        <span className="skip-icon">⏩</span>
                        <span className="btn-text">Skip {selectedReactor} Phase</span>
                    </button>
                </div>

                {/* Bottom Status / Clear Footer */}
                <div className="demo-col-footer">
                    <div className="demo-footer-status">
                        <span className={`status-indicator ${faults.length > 0 ? 'alarm' : 'ok'}`} />
                        <span className="status-text">
                            {faults.length > 0 ? `${faults.length} Fault(s) Active` : 'No Faults'}
                        </span>
                    </div>
                    {faults.length > 0 && (
                        <button
                            className="btn-clear-inline"
                            onClick={clearAllFaults}
                            title="Clear all injected faults">
                            Reset All
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}