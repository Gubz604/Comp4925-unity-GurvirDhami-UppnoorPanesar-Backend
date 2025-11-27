const database = require('../databaseConnection');

// Get existing progress for one user
async function getProgress(user_id) {
    const [rows] = await database.execute(
        'SELECT max_wave, high_score FROM user_progress WHERE user_id = ? LIMIT 1',
        [user_id]
    );
    return rows[0] || null;
}

async function upsertProgress(userId, wave, score) {
    // Current row for this user, e.g. { high_score: 420, max_wave: 5 }
    const row = await getProgress(userId); 

    if (!row) {
        // First time: insert exactly what we got
        const insertSql = `
            INSERT INTO user_progress (user_id, max_wave, high_score)
            VALUES (:userId, :wave, :score)
        `;
        await database.query(insertSql, { userId, wave, score });
        return;
    }

    // Existing best stats
    let bestScore = row.high_score;
    let bestWave  = row.max_wave;

    // --- Decide if this run beats the existing record ---

    if (score > bestScore) {
        // Strictly better score: update both score + wave
        bestScore = score;
        bestWave  = wave;
    } else if (score === bestScore && wave > bestWave) {
        // Same score, but reached on a later wave: update wave only
        bestWave = wave;
    } else {
        // Worse score, or same score on an earlier/same wave -> ignore
        return;
    }

    // --- Write the new best values back to the DB ---
    const updateSql = `
        UPDATE user_progress
        SET high_score = :bestScore,
            max_wave   = :bestWave
        WHERE user_id  = :userId
    `;

    await database.query(updateSql, {
        userId,
        bestScore,
        bestWave,
    });
}


module.exports = {
    getProgress,
    upsertProgress,
};
