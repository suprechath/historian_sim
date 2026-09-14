import React, { useState } from 'react';
import Header from '../components/Header';
import ProcessMimic from '../components/ProcessMimic';
import TrendCanvas from '../components/TrendCanvas';
import TagTable from '../components/TagTable';
import DemoControls from '../components/DemoControls';
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
                {/* <div className="lower">
                    <TrendCanvas
                        selectedReactor={selectedReactor}
                        onSelectReactor={setSelectedReactor}
                        clock={stream.clock}
                    />
                    <TagTable tags={stream.tags} reactors={stream.reactors} />
                </div>
                <DemoControls selectedReactor={selectedReactor} /> */}
            </main>
        </div>
    );
}