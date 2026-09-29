# Command termination failures

The reported incident trace identified an uncaught `kill EPERM` from `signalCommand` through `terminate` and the timeout callback (installed `dist/server/util.js`, lines 29, 83 and 91). The historical child/process-group identity, permission-denial cause and server exit status remain unknown. The controlled reproduction below establishes the exception mechanism, not that historical target or denial reason.

## Behavior

[`runCommand`](../server/util.ts) catches non-`ESRCH` signal errors at both its initial `SIGTERM` and existing two-second `SIGKILL` callbacks. It rejects the command promptly with timeout/abort context, the failed signal, original error as `cause`, and **process cleanup is unconfirmed**. It clears the command's timers and abort listener. A later zero exit cannot turn that rejection into success. There is no new retry, deadline extension, fallback, uncaught-exception handler or supervisor.

Promise settlement is not process disappearance: a rejected command stays in the existing owned-command set until its `close` event. Explicit shutdown still rejects on a signal refusal rather than claiming cleanup. Its existing delayed escalation now checks that the command remains tracked, avoiding another signal after observed close. No PID discovery or foreign-process targeting is added. `ESRCH` retains its existing benign-disappearance handling. Successful commands and ordinary timeout/abort results retain their existing shape and flags.

A refused process can remain alive; rejection is neither proof of termination nor containment of detached descendants. This fix does not diagnose host permissions, change sandboxing or guarantee cleanup after an OS refusal.

## Verification limits

Deterministic fixtures exercise the supported contract, not live provider or installed runtime readiness. See [public validation](publication-readiness.md).
