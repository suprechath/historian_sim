import React, { useState } from 'react';
import Header from '../components/Header';
import ProcessMimic from '../components/ProcessMimic';
import TrendCanvas from '../components/TrendCanvas';
import TagTable from '../components/TagTable';
import DemoControls from '../components/DemoControls';
import EventsFeed from '../components/EventsFeed';
import { useHistorianStream } from '../hooks/useHistorianStream';

export default function PlantOverview() {
    const [selectedReactor, setSelectedReactor] = useState('R1');
    const stream = useHistorianStream();

    return (
        <div>
            <Header
                clock={stream.clock}
                running={stream.running}
                speed={stream.speed}
                connected={stream.connected}
            />
            <main>
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
                            <b> Controls</b> Injected faults & phase skip
                        </p>
                        <DemoControls
                            selectedReactor={selectedReactor}
                            onSelectReactor={setSelectedReactor}
                        />
                    </div>
                </div>

                <div style={{ marginTop: 14 }}>
                    <TrendCanvas
                        selectedReactor={selectedReactor}
                        onSelectReactor={setSelectedReactor}
                        clock={stream.clock}
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
        </div>
    );
}