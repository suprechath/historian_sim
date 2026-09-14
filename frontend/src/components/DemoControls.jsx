import React, { useState, useEffect } from 'react';

export default function DemoControls({ selectedReactor }) {
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
                body: JSON.stringify({ tag, kind, magnitude: 1.5 })
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
        <div className="panel ctrls">
            <span>Demo controls ({selectedReactor})</span>
            <button
                className={`btn ${hasDropout ? 'on' : ''}`}
                onClick={() => toggleFault('dropout')}>
                Fail a sensor
            </button>
            <button
                className={`btn ${hasDrift ? 'on' : ''}`}
                onClick={() => toggleFault('drift')}>
                Start drift
            </button>
            <button className="btn" onClick={clearAllFaults}>
                Clear faults
            </button>
            <button className="btn" onClick={skipPhase}>
                Skip phase
            </button>
        </div>
    );
}