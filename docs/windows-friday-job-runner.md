# Windows Friday Job Object runner

The Windows recovery supervisor starts a worker inside a private Job Object. The
runner uses the authenticated Node executable, an explicit working directory,
and the exact worker arguments supplied by the supervising process. Only
standard input, output, and error handles reach the worker. A caller can send a
private recovery frame on stdin.

A supported setup uses Windows 10 or 11 with process creation job-list support.
The runner assigns the job at process creation, verifies membership before
resuming the worker, and waits for the whole job to empty. An unconfirmed stop
requires operator inspection before a retry. [Microsoft process creation and
handle inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/creating-processes),
[Process thread attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)

The runner retains a handle to its Windows-reported launching process. If that process
dies, the runner terminates the owned job and checks that it has reaped the
worker. If the runner itself dies, Windows kills the job when its last job
handle closes. The caller must still reconcile effects after a lost
response. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

Use a trusted local build of the reviewed source. The Windows native fixture
compiles it with the built-in 64-bit .NET Framework compiler and verifies its
process behavior using only synthetic workers.

```text
WindowsJobRunner.exe <launcher-pid> <deadline-ms> <local-node-exe> <local-working-dir> [worker-arguments...]
```

The launching process supplies its PID directly. When it needs the runner to
report unexpected launcher death, start the runner detached with hidden
windows and piped standard streams. This leaves the runner alive to observe
the launcher exit. [libuv Windows child process behavior](https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c#L988-L1035)

| Exit code | Meaning                                                                                 |
| --------- | --------------------------------------------------------------------------------------- |
| 0         | Worker succeeded and the job is empty.                                                  |
| 220       | Worker failed and the job is empty.                                                     |
| 221       | Deadline elapsed and the owned job is empty.                                            |
| 222       | Launcher exited and the owned job was stopped and reaped.                               |
| 223       | Setup was refused before the worker could run.                                          |
| 224       | The runner could not confirm the outcome. Inspect the retained attempt before retrying. |

This runner is a process-supervision component. The retained launchers still need
the integrated job, deadline, output, and result-verification path before
scheduled adoption.
