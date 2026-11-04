import React, { useState, useEffect } from 'react';

function formatDate(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
        `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

export default function Header({
    clock,
    running,
    speed,
    connected,
    mode,
    assignedBatchId,
    singleBatchStatus,
    integrationHealth,
    integrationConnected = true,
    pendingOutboundCount = 0,
    activePage = 'overview',
    onNavigate,
    pendingScheduledCount = 0
}) {
    const [isToggling, setIsToggling] = useState(false);
    const [toastMessage, setToastMessage] = useState(null);
    const [localConnected, setLocalConnected] = useState(null);

    // Sync optimistic local state whenever prop updates from stream
    useEffect(() => {
        setLocalConnected(null);
    }, [integrationConnected]);

    const isConnected = localConnected !== null ? localConnected : Boolean(integrationConnected);

    const handleSpeed = async (newSpeed, newRunning) => {
        try {
            await fetch('/ui/simulation/state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ speed: newSpeed, running: newRunning })
            });
        } catch (err) {
            console.error('Speed change error:', err);
        }
    };

    // Handler for the fake disconnection / reconnection flipping toggle
    const handleToggleIntegrationConnection = async () => {
        if (isToggling) return;
        const targetState = !isConnected;
        setIsToggling(true);
        setLocalConnected(targetState); // Instant visual feedback
        setToastMessage(null);

        try {
            const res = await fetch('/ui/simulation/integration-connection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connected: targetState })
            });
            const data = await res.json();

            if (res.ok) {
                setLocalConnected(Boolean(data.connected));
                if (!data.connected) {
                    setToastMessage(`Disconnected. Broadcast sent to ${data.broadcastCount || 0} batch(es).`);
                } else {
                    setToastMessage(`Reconnected. Flushed ${data.flushedCount || 0} pending message(s).`);
                }
            } else {
                setLocalConnected(null);
                setToastMessage(`Error: ${data.error || 'Failed to toggle'}`);
            }
        } catch (err) {
            console.error('Connection toggle error:', err);
            setLocalConnected(null);
            setToastMessage(`Connection error: ${err.message}`);
        } finally {
            setIsToggling(false);
            setTimeout(() => setToastMessage(null), 5000);
        }
    };

    return (
        <header>
            <div className="brand">
                API Plant Historian <span>— {activePage === 'scheduled' ? 'Scheduled Instructions' : 'Process overview'}</span>
            </div>

            {/* Navigation Switcher: Process Mimic vs Scheduled Tasks */}
            <nav className="header-nav-tabs" role="tablist" aria-label="Historian views">
                <button
                    type="button"
                    role="tab"
                    aria-selected={activePage === 'overview'}
                    className={`nav-tab-btn ${activePage === 'overview' ? 'active' : ''}`}
                    onClick={() => onNavigate && onNavigate('overview')}
                    title="Process Mimic & Trend Overview"
                >
                    <svg className="nav-tab-icon" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11z" />
                        <path d="M3 5h3v7H3V5zm4 3h3v4H7V8zm4-5h2v9h-2V3z" />
                    </svg>
                    <span>Process Mimic</span>
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activePage === 'scheduled'}
                    className={`nav-tab-btn ${activePage === 'scheduled' ? 'active' : ''}`}
                    onClick={() => onNavigate && onNavigate('scheduled')}
                    title="Scheduled Instructions Queue (scheduled_instructions)"
                >
                    <svg className="nav-tab-icon" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8.5 5.5a.5.5 0 0 0-1 0v3.379l1.646 1.647a.5.5 0 0 0 .708-.708L8.5 8.543V5.5z"/>
                        <path d="M6.5 1A1.5 1.5 0 0 0 5 2.5V3H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1v-.5A1.5 1.5 0 0 0 9.5 1h-3zm3 1a.5.5 0 0 1 .5.5V3h-4v-.5a.5.5 0 0 1 .5-.5h3zM3 5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1H3V5zm10 2v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7h10z"/>
                    </svg>
                    <span>Scheduled Tasks</span>
                    {pendingScheduledCount > 0 && (
                        <span className="nav-tab-counter" title={`${pendingScheduledCount} pending scheduled task(s)`}>
                            {pendingScheduledCount}
                        </span>
                    )}
                </button>
            </nav>

            <div className="clock">
                {formatDate(clock)} <small>UTC+0</small>
            </div>

            <div className="hdr-r">
                {/* Integration Server Connection Simulation Flipping Toggle */}
                <div
                    className={`integration-toggle-wrapper ${!isConnected ? 'offline-active' : 'online-active'}`}
                    title={
                        isConnected
                            ? 'Integration Server is ONLINE. Click to simulate disconnection (Warning broadcast to active batches from last 5min, Store-and-Forward queue buffering).'
                            : `Integration Server is SIMULATED OFFLINE (${pendingOutboundCount} buffered). Click to reconnect and flush pending queue.`
                    }
                >
                    <button
                        type="button"
                        className={`flip-toggle-btn ${isConnected ? 'btn-connected' : 'btn-disconnected'}`}
                        onClick={handleToggleIntegrationConnection}
                        disabled={isToggling}
                        aria-pressed={isConnected}
                        aria-label="Toggle integration server fake disconnection"
                    >
                        <span className="flip-slider">
                            <span className="flip-knob" />
                        </span>
                        <span className="flip-title">
                            <b>Int-Server:</b> {isToggling ? '...' : isConnected ? 'ONLINE' : 'OFFLINE'}
                        </span>
                        {!isConnected && (
                            <span className="flip-buffered-badge" title={`${pendingOutboundCount} outbound request(s) buffered in Store-and-Forward queue`}>
                                {pendingOutboundCount} buf
                            </span>
                        )}
                    </button>
                    {toastMessage && (
                        <div className="toggle-toast-pill" role="status">
                            {toastMessage}
                        </div>
                    )}
                </div>

                {integrationHealth && (
                    <div
                        className={`integration-chip ${integrationHealth.status} ${integrationHealth.isRecentOnDemand ? 'pulse-alert' : ''}`}
                        title={`Integration Status: ${integrationHealth.message} (${integrationHealth.ageSeconds}s ago)`}
                    >
                        <span className="integration-chip-dot" />
                        <span className="integration-chip-text">
                            {integrationHealth.isRecentOnDemand ? (
                                <>
                                    <b>BatchLine Check:</b> {integrationHealth.status.toUpperCase()} <small>[{integrationHealth.latency_ms}ms]</small>
                                </>
                            ) : (
                                <>
                                    <b>System:</b> {integrationHealth.status === 'passed' ? 'Heartbeat OK' : 'DEGRADED'} <small>[{Math.max(0, Math.round(integrationHealth.ageSeconds / 60))}m ago]</small>
                                </>
                            )}
                        </span>
                    </div>
                )}
                <div className={`batch-mode-chip ${mode === 'single' ? 'single' : 'continuous'}`} title={mode === 'single' ? `Single Assigned Batch Mode: ${assignedBatchId || 'Pending'}` : 'Continuous Train Mode: Auto-sequencing'}>
                    <span className="mode-chip-dot" />
                    <span className="mode-chip-text">
                        {mode === 'single' ? (
                            <>
                                <b>Single:</b> {assignedBatchId || 'Manual'} <small className="mode-status-sub">[{singleBatchStatus || 'idle'}]</small>
                            </>
                        ) : (
                            'Continuous Auto-Train'
                        )}
                    </span>
                </div>
                <div className={`live ${!running || !connected ? 'paused' : ''}`}>
                    <i />
                    <span>{!connected ? 'Disconnected' : !running ? 'Paused' : 'Live'}</span>
                </div>
                <div className="speed" role="group" aria-label="Simulation speed">
                    <button
                        aria-pressed={running && speed === 1}
                        onClick={() => handleSpeed(1, true)}>
                        1&times;
                    </button>
                    <button
                        aria-pressed={running && speed === 5}
                        onClick={() => handleSpeed(5, true)}>
                        5&times;
                    </button>
                    <button
                        aria-pressed={running && speed === 10}
                        onClick={() => handleSpeed(10, true)}>
                        10&times;
                    </button>
                    <button
                        aria-pressed={running && speed === 30}
                        onClick={() => handleSpeed(30, true)}>
                        30&times;
                    </button>
                    <button
                        aria-pressed={running && speed === 60}
                        onClick={() => handleSpeed(60, true)}>
                        60&times;
                    </button>
                    <button
                        aria-pressed={!running}
                        onClick={() => handleSpeed(speed || 1, !running)}>
                        {running ? 'Pause' : 'Resume'}
                    </button>
                </div>
            </div>
        </header>
    );
}
