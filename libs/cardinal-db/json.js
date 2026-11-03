function cloneJson(value) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    } catch (error) {
        throw new TypeError(`Cardinal DB values must be JSON serializable: ${error.message}`);
    }
    if (serialized === undefined) {
        throw new TypeError('Cardinal DB values must be JSON serializable.');
    }
    return JSON.parse(serialized);
}

module.exports = { cloneJson };
