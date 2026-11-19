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

The selected-load evidence installer and retained first and second executors use this job runner on Windows. Its host
build verifies the reviewed source hash, compiles with the fixed system compiler
in a new private temporary directory, and launches the authenticated retained
Node worker through the runner. The host verifies the installed evidence before
returning success. Missing build support refuses before a retained process starts.
The other retained launchers and scheduler-context
rehearsal remain separate integration work.

## One explicitly supervised mailbox poll

After building the reviewed checkout with `npm run build:etl`, provide a private
UTF-8 JSON file with the two absolute directories, confirmed mailbox account,
Friday edition and canonical UTC scan start. Keep the configuration outside the
repository. The frame holds no access token, refresh token or message body.

```json
{
  "credentialDirectory": "C:\\private\\zivv-gmail",
  "operatorDirectory": "C:\\private\\zivv-operator",
  "expectedAccountId": "<confirmed-mailbox>",
  "expectedEditionId": "2026-11-20",
  "scanStartsAt": "2026-11-19T08:00:00.000Z"
}
```

```powershell
Get-Content -LiteralPath "$privatePollConfig" -Raw -Encoding utf8 |
  node scripts/steve-gmail.js poll-friday-supervised --worker-budget-ms $workerBudgetMs
```

Choose and review the worker budget for this host before each rollout. The
command requires an explicit integer from 1 to 600000 milliseconds. That budget
covers the full worker process and its descendants, including credential
refresh, the fresh search, local handoff and in-process retries. The search
also has its own read budget. Monday midnight Pacific remains the deadline for
starting another capture. The supervisor emits a bounded result without
mailbox identity, paths, secrets, or receipt bodies.

A confirmed stop proves that the job was reaped. A stopped or unconfirmed
result can still leave a durable batch, or a refresh-token rotation that needs
inspection. Check the private handoff and credential state before relying on
a subsequent invocation. If the provider revoked the old token before the
replacement was committed, follow the existing private credential renewal
procedure. The parent does not rerun the job automatically.

The regular `poll`, `poll-friday`, and manual import commands remain available.
This entry point registers no scheduled task.

The retained Gmail restart rehearsal runs the production poll and credential
handoff libraries inside fresh Windows workers supervised by the Job Object.
A synthetic Friday wake restores the exact pending signed capture before
credential access. A second worker at Monday midnight returns the review
boundary without running capture. Both preserve the signed batch. The
rehearsal uses a controlled clock and a forbidden network adapter. A real
Windows restart and a scheduled run remain separate acceptance steps.
