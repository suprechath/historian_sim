import React, { useState, useEffect } from 'react';
import ProcessMimic from '../components/ProcessMimic';
import TrendCanvas from '../components/TrendCanvas';
import TagTable from '../components/TagTable';
import DemoControls from '../components/DemoControls';
import EventsFeed from '../components/EventsFeed';
import { useHistorianStream } from '../hooks/useHistorianStream';

export default function PlantOverview({ stream: propStream }) {
    const [selectedReactor, setSelectedReactor] = useState('R1');
    const localStream = useHistorianStream();
    const stream = propStream || localStream;

    // Track 1-column layout breakpoint (matches CSS media query <= 1750px)
    const [is1ColMode, setIs1ColMode] = useState(() => {
        if (typeof window !== 'undefined') {
            return window.innerWidth <= 1750;
        }
        return false;
    });

    useEffect(() => {
        const handleResize = () => {
            setIs1ColMode(window.innerWidth <= 1750);
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Collapsed state for DemoControls in 1-column mode with localStorage persistence
    const [isDemoCollapsed, setIsDemoCollapsed] = useState(() => {
        try {
            return localStorage.getItem('historian_democontrols_collapsed') === 'true';
        } catch {
            return false;
        }
    });

    const toggleDemoCollapse = () => {
        setIsDemoCollapsed((prev) => {
            const next = !prev;
            try {
                localStorage.setItem('historian_democontrols_collapsed', String(next));
            } catch (e) {
                console.error(e);
            }
            return next;
        });
    };

    // Only collapse when in 1-column mode
    const effectiveCollapsed = is1ColMode && isDemoCollapsed;

    return (
        <main className="plant-overview-main">
            <div className="mimic-deck">
                <div className="mimic-main-col">
                    <p className="shead">
                        <b>Process mimic</b> Click a vessel to trend it
                    </p>
                    <ProcessMimic
                        reactors={stream.reactors}
                        tags={stream.tags}
                        selectedReactor={selectedReactor}
                        onSelectReactor={setSelectedReactor}
                        running={stream.running}
                        speed={stream.speed}
                    />
                </div>
                <div className="mimic-side-col">
                    <p
                        className={`shead ${is1ColMode ? 'shead-collapsible' : ''}`}
                        onClick={is1ColMode ? toggleDemoCollapse : undefined}
                        title={is1ColMode ? (effectiveCollapsed ? "Click to expand Simulator Controls" : "Click to collapse Simulator Controls") : undefined}
                        style={{ cursor: is1ColMode ? 'pointer' : 'default' }}>
                        <b>Simulator Controls</b>
                        {is1ColMode && (
                            <button
                                type="button"
                                className={`trend-collapse-btn demo-collapse-btn ${effectiveCollapsed ? 'collapsed' : ''}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    toggleDemoCollapse();
                                }}
                                title={effectiveCollapsed ? "Expand Simulator Controls" : "Collapse Simulator Controls"}
                                aria-expanded={!effectiveCollapsed}>
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 16 16"
                                    fill="currentColor"
                                    style={{
                                        transition: 'transform 0.2s ease',
                                        transform: effectiveCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'
                                    }}>
                                    <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z" />
                                </svg>
                                <span>{effectiveCollapsed ? 'Expand' : 'Collapse'}</span>
                            </button>
                        )}
                    </p>
                    <DemoControls
                        selectedReactor={selectedReactor}
                        onSelectReactor={setSelectedReactor}
                        mode={stream.mode}
                        assignedBatchId={stream.assignedBatchId}
                        singleBatchStatus={stream.singleBatchStatus}
                        batchQueue={stream.batchQueue || []}
                        running={stream.running}
                        speed={stream.speed}
                        reactors={stream.reactors}
                        isCollapsed={isDemoCollapsed}
                        onToggleCollapse={toggleDemoCollapse}
                        is1ColMode={is1ColMode}
                    />
                </div>
            </div>

            <div style={{ marginTop: 14 }}>
                <TrendCanvas
                    selectedReactor={selectedReactor}
                    onSelectReactor={setSelectedReactor}
                    clock={stream.clock}
                    tags={stream.tags}
                />
            </div>

            <div className="bottom-feed-grid">
                <div className="bottom-col">
                    <p className="shead">
                        <b>1-Minute Rollup Audit & Data Verification</b> Continuous aggregates · {selectedReactor}
                    </p>
                    <TagTable
                        selectedReactor={selectedReactor}
                        onSelectReactor={setSelectedReactor}
                    />
                </div>
                <div className="bottom-col">
                    <p className="shead">
                        <b>Events & Process Alarms Feed</b> Real-time transitions & alarms · {selectedReactor}
                    </p>
                    <EventsFeed
                        selectedReactor={selectedReactor}
                        onSelectReactor={setSelectedReactor}
                    />
                </div>
            </div>
        </main>
    );
}
