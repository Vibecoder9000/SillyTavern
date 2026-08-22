/**
 * Reads the total animation duration from an animated WebP RIFF buffer.
 *
 * WebP animation frame durations are stored as 24-bit little-endian values
 * in each ANMF chunk. A null result means that the buffer is not a valid
 * animated WebP or contains no animation frames.
 *
 * @param {ArrayBuffer | Uint8Array} source WebP file contents.
 * @returns {number | null} Total duration in milliseconds.
 */
export function getAnimatedWebpDuration(source) {
    const bytes = source instanceof Uint8Array ? source : source instanceof ArrayBuffer ? new Uint8Array(source) : null;
    if (!bytes || bytes.byteLength < 12) return null;

    const readFourCc = (offset) => String.fromCharCode(
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    );

    if (readFourCc(0) !== 'RIFF' || readFourCc(8) !== 'WEBP') return null;

    let offset = 12;
    let duration = 0;
    let frameCount = 0;

    while (offset + 8 <= bytes.byteLength) {
        const chunkType = readFourCc(offset);
        const chunkSize = bytes[offset + 4]
            | (bytes[offset + 5] << 8)
            | (bytes[offset + 6] << 16)
            | (bytes[offset + 7] << 24);

        if (chunkSize < 0 || offset + 8 + chunkSize > bytes.byteLength) return null;

        if (chunkType === 'ANMF') {
            if (chunkSize < 16) return null;
            const frameOffset = offset + 8;
            const frameDuration = bytes[frameOffset + 12]
                | (bytes[frameOffset + 13] << 8)
                | (bytes[frameOffset + 14] << 16);
            duration += frameDuration;
            frameCount++;
        }

        // RIFF chunks are padded to an even byte boundary.
        offset += 8 + chunkSize + (chunkSize & 1);
    }

    return frameCount > 0 && duration > 0 ? duration : null;
}
