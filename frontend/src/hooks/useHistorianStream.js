import { useState, useEffect } from 'react';

export function useHistorianStream() {
    const [data, setData] = useState({
        clock: null,
        running: true,
        speed: 1,
        reactors: { R1: { phase: 'Idle' }, R2: { phase: 'Idle' }, R3: { phase: 'Idle' } },
        tags: []
    });
    const [connected, setConnected] = useState(false);

    useEffect(() => {
        const es = new EventSource('/ui/stream');

        es.onopen = () => setConnected(true);

        es.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                // console.log("payload", payload)
                setData(payload);
            } catch (err) {
                console.error('SSE JSON error:', err);
            }
        };

        es.onerror = () => setConnected(false);

        return () => es.close();
    }, []);

    return { ...data, connected };
}