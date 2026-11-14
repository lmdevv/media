/** True while a process with this ID exists: signal 0 checks for it and delivers nothing. */
export const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};
