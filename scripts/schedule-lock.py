#!/usr/bin/env python3
"""Hold an advisory coordinator lock until the owning parent's stdin closes."""
import fcntl
import os
import stat
import sys

fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        raise RuntimeError("Scheduler lock must be a regular file")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("READY", flush=True)
    while sys.stdin.buffer.read(1024):
        pass
finally:
    os.close(fd)
