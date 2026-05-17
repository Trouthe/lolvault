const { execSync } = require('child_process');

/**
 * Gets the total commit count for the Git repository.
 * @param {string} [repoPath=process.cwd()] - Path within the Git repository.
 * @returns {number} The commit count.
 */
function getGitCommitCount(repoPath = process.cwd()) {
  try {
    const count = execSync('git rev-list --count HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: true,
    });

    return parseInt(count.trim(), 10);
  } catch (error) {
    console.error('Error counting Git commits:', error.message);
    return 0;
  }
}

module.exports = getGitCommitCount;
