/**
 * Creates a trailing, coalescing writer. There is never more than one write in
 * flight and one replacement snapshot waiting behind it.
 */
export function createCoalescedWriter(write, { delay = 250, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let timer = null;
    let latest = null;
    let inFlight = null;

    async function drain() {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            while (latest !== null) {
                const value = latest;
                latest = null;
                await write(value);
            }
        })().finally(() => {
            inFlight = null;
        });
        return inFlight;
    }

    function schedule(value) {
        latest = value;
        if (timer !== null) clearTimer(timer);
        timer = setTimer(() => {
            timer = null;
            void drain();
        }, delay);
    }

    async function flush(value) {
        if (value !== undefined) latest = value;
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
        if (inFlight) await inFlight;
        return drain();
    }

    return {
        schedule,
        flush,
    };
}
