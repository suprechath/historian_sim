import React, { useState, useEffect } from 'react';

function HealthMessageView({ message, status }) {
    if (!message) return null;

    // Pattern: [Historian HealthCheck]: PASSED at Oct 14, 2026 11:07:39 (DB: Connected, Latency: 1ms, Batch: ff_261011_0_1)
    const match = message.match(/^\[Historian HealthCheck\]:\s*([A-Z]+)\s+at\s+([^(]+)(?:\((.*)\))?/i);

    if (match) {
        const [, , timeStr, metaStr] = match;
        const details = metaStr ? metaStr.split(',').map((s) => s.trim()) : [];
        const dbPart = details.find((d) => d.toLowerCase().startsWith('db')) || (status === 'passed' ? 'DB: Connected' : 'DB: Failed');
        const isPassed = status === 'passed';

        return (
            <div className="healthcheck-msg-content">
                <div className="healthcheck-msg-headline">
                    {isPassed
                        ? 'TimeScaleDB connection verified and responsive.'
                        : 'Database verification failed to connect.'}
                </div>
                <div className="healthcheck-msg-chips">
                    <span className={`msg-chip msg-chip-db ${isPassed ? 'ok' : 'err'}`}>
                        <span className="msg-chip-dot" />
                        {dbPart}
                    </span>
                    {timeStr && (
                        <span className="msg-chip msg-chip-time" title="Verified timestamp">
                            <svg className="chip-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="8" cy="8" r="6" />
                                <polyline points="8 4.5 8 8 10.5 9.5" />
                            </svg>
                            {timeStr.trim()}
                        </span>
                    )}
                </div>
                <details className="healthcheck-raw-details">
                    <summary className="healthcheck-raw-summary">Diagnostic Details</summary>
                    <code className="healthcheck-raw-code">{message}</code>
                </details>
            </div>
        );
    }

    const cleanMsg = message.replace(/^\[Historian HealthCheck\]:\s*/i, '');
    return <p className="message-text">{cleanMsg}</p>;
}

export default function HealthCheckDialog({ health, onDismiss }) {
    if (!health) return null;

    return (
        <div
            className="healthcheck-popup-backdrop"
            onClick={onDismiss}
        >
            <div
                className={`healthcheck-popup-card ${health.status}`}
                onClick={(e) => e.stopPropagation()}
                role="alertdialog"
                aria-modal="true"
            >
                <div className="healthcheck-popup-header">
                    <div className="healthcheck-popup-title">
                        <span className="healthcheck-popup-icon">
                            {health.status === 'passed' ? '✓' : '!'}
                        </span>
                        <span>BatchLine Health Check</span>
                    </div>
                    <button
                        className="healthcheck-popup-close"
                        onClick={onDismiss}
                        title="Close"
                    >
                        &times;
                    </button>
                </div>

                <div className="healthcheck-popup-body">
                    <div className="healthcheck-popup-badge-row">
                        <div className={`healthcheck-status-pill ${health.status}`}>
                            <span className="status-beacon" />
                            <span className="status-pill-text">
                                {health.status === 'passed' ? 'Verification Passed' : 'Verification Failed'}
                            </span>
                        </div>
                        <div className="healthcheck-time-pill" title="Time elapsed since health check">
                            <svg className="time-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="8" cy="8" r="6" />
                                <polyline points="8 4.5 8 8 10.5 9.5" />
                            </svg>
                            <span>{health.ageSeconds}s ago</span>
                        </div>
                    </div>

                    <div className={`healthcheck-popup-message-box ${health.status}`}>
                        <div className="message-icon-col">
                            {health.status === 'passed' ? (
                                <svg viewBox="0 0 20 20" fill="currentColor" className="msg-svg">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                </svg>
                            ) : (
                                <svg viewBox="0 0 20 20" fill="currentColor" className="msg-svg">
                                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                                </svg>
                            )}
                        </div>
                        <div className="message-content">
                            <span className="message-title" style={{ fontSize: '13px', fontWeight: 900 }}>
                                {health.status === 'passed' ? 'System Operational' : 'Integration Alert'}
                            </span>
                            <HealthMessageView
                                message={health.message}
                                status={health.status}
                            />
                        </div>
                    </div>

                    <div className="healthcheck-metric-grid">
                        <div className="metric-card">
                            <div className="metric-card-header">
                                <svg className="metric-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
                                    <path d="M5.5 3.5V2a.5.5 0 01.5-.5h4a.5.5 0 01.5.5v1.5" />
                                    <path d="M2.5 7h11" />
                                </svg>
                                <span className="metric-card-label">Target Batch</span>
                            </div>
                            <div className="metric-card-body">
                                <span className={`metric-code-badge ${health.batch_id ? 'active' : 'empty'}`}>
                                    {health.batch_id || 'N/A'}
                                </span>
                            </div>
                        </div>

                        <div className="metric-card">
                            <div className="metric-card-header">
                                <svg className="metric-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M1 8.5h2.5l2-5 3 9 2-5 1.5 2.5H15" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                                <span className="metric-card-label">Latency</span>
                                <span
                                    className={`latency-indicator ${health.latency_ms < 500
                                        ? 'optimal'
                                        : health.latency_ms < 1500
                                            ? 'normal'
                                            : 'high'
                                        }`}
                                    title={`Latency: ${health.latency_ms}ms`}
                                />
                            </div>
                            <div className="metric-card-body">
                                <span className="metric-num-val">{health.latency_ms}</span>
                                <span className="metric-unit-text">ms</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="healthcheck-popup-footer">
                    {health?.batch_id && health.batch_id !== 'UNKNOWN' && (
                        <span className="healthcheck-footer-hint" style={{ marginRight: 'auto', fontSize: '11px', color: '#64748b' }}>
                            Batch <b>{health.batch_id}</b> will start (Wait for R1)
                        </span>
                    )}
                    <button
                        className="healthcheck-popup-btn"
                        onClick={onDismiss}
                        autoFocus
                    >
                        OK
                    </button>
                </div>
            </div>
        </div>
    );
}

