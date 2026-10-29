import React, { useState } from 'react';
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
                    <p className="shead">
                        <b>Simulator Controls</b>
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
