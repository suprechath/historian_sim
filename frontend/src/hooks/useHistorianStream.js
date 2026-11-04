import { useState, useEffect } from 'react';

export function useHistorianStream() {
    const [data, setData] = useState({
        clock: null,
        running: true,
        speed: 1,
        mode: 'continuous',
        assignedBatchId: null,
        singleBatchStatus: 'idle',
        batchQueue: [],
        reactors: { R1: { phase: 'Idle' }, R2: { phase: 'Idle' }, R3: { phase: 'Idle' } },
        tags: [],
        integrationHealth: null,
        pendingScheduledCount: 0,
        pendingOutboundCount: 0,
        integrationConnected: true
    });
    const [connected, setConnected] = useState(false);

    useEffect(() => {
        const es = new EventSource('/ui/stream');

        es.onopen = () => setConnected(true);

        es.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                setData((prev) => ({
                    ...prev,
                    ...payload,
                    pendingScheduledCount: payload.pendingScheduledCount !== undefined
                        ? payload.pendingScheduledCount
                        : prev.pendingScheduledCount,
                    pendingOutboundCount: payload.pendingOutboundCount !== undefined
                        ? payload.pendingOutboundCount
                        : prev.pendingOutboundCount,
                    integrationConnected: payload.integrationConnected !== undefined
                        ? payload.integrationConnected
                        : prev.integrationConnected
                }));
            } catch (err) {
                console.error('SSE JSON error:', err);
            }
        };

        es.onerror = () => setConnected(false);

        return () => es.close();
    }, []);

    return { ...data, connected };
}
