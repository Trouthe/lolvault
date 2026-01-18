const { execSync } = require('child_process');

/**
 * Gets the total commit count for the Git repository
 * @param {string} [repoPath=process.cwd()] - Path to the Git repository (local path only)
 * @returns {number} The commit count
 */
function getGitCommitCount(repoPath = process.cwd()) {
    try {
        const count = execSync('git rev-list --count HEAD', {
            cwd: process.cwd(), // Use current directory regardless of passed URL
            encoding: 'utf-8',
            shell: true, // Explicitly specify to use shell
        });
        return parseInt(count.trim(), 10);
    } catch (error) {
        console.error('Error counting Git commits:', error.message);
        return 0;
    }
}

module.exports = getGitCommitCount;
