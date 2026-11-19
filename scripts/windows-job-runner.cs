using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Keep the job handle private to the runner. The worker receives exactly its
// three standard streams. Raw input, including any private frame, bypasses us.
internal static class WindowsJobRunner
{
    private const int WorkerFailed = 220;
    private const int DeadlineStopped = 221;
    private const int ParentStopped = 222;
    private const int SetupRefused = 223;
    private const int TerminationUnconfirmed = 224;

    private const uint WaitObject = 0;
    private const uint WaitTimeout = 258;
    private const uint SynchronizeAndQuery = 0x00101000;
    private const uint KillOnJobClose = 0x00002000;
    private const uint JobAccountingClass = 1;
    private const uint JobLimitsClass = 9;
    private const uint CreationFlags = 0x08080004; // no window, extended startup, suspended
    private const int AttributeHandleList = 0x00020002;
    private const int AttributeJobList = 0x0002000d;

    public static int Main(string[] args)
    {
        uint parentId;
        int deadlineMs;
        if (args.Length < 4 ||
            !uint.TryParse(args[0], NumberStyles.None, CultureInfo.InvariantCulture, out parentId) ||
            !int.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out deadlineMs) ||
            deadlineMs < 1 || deadlineMs > 600000)
            return SetupRefused;

        IntPtr parent = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        var worker = new Worker();
        var clock = Stopwatch.StartNew();
        try
        {
            if (!IsAbsoluteLocalPath(args[2]) || !IsAbsoluteLocalPath(args[3]))
                return SetupRefused;
            parent = OpenLiveParent(parentId);
            if (parent == IntPtr.Zero) return SetupRefused;

            job = Native.CreateJobObject(IntPtr.Zero, null);
            var limits = new JobLimits();
            limits.Basic.LimitFlags = KillOnJobClose;
            if (job == IntPtr.Zero || !Native.SetInformationJobObject(
                job, JobLimitsClass, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))))
                return SetupRefused;

            if (clock.ElapsedMilliseconds >= deadlineMs) return DeadlineStopped;
            worker = StartWorker(job, args);
            if (worker.Process == IntPtr.Zero) return SetupRefused;
            bool member;
            if (!Native.IsProcessInJob(worker.Process, job, out member) || !member)
                return StopSuspendedWorker(worker.Process);

            uint parentState = Native.WaitForSingleObject(parent, 0);
            if (parentState != WaitTimeout) return StopForParent(job, worker.Process, parentState);
            if (clock.ElapsedMilliseconds >= deadlineMs)
                return StopJob(job, worker.Process, DeadlineStopped);
            if (Native.ResumeThread(worker.Thread) != 1)
                return StopJob(job, worker.Process, TerminationUnconfirmed);

            for (;;)
            {
                parentState = Native.WaitForSingleObject(parent, 0);
                if (parentState != WaitTimeout) return StopForParent(job, worker.Process, parentState);
                uint active;
                if (!TryActiveProcesses(job, out active))
                    return StopJob(job, worker.Process, TerminationUnconfirmed);
                long left = deadlineMs - clock.ElapsedMilliseconds;
                if (left <= 0) return StopJob(job, worker.Process, DeadlineStopped);
                if (active == 0)
                {
                    uint rootState = Native.WaitForSingleObject(worker.Process, 0);
                    // Job accounting and the process handle are separate
                    // observations. Allow the handle to catch up within the
                    // same deadline before reporting an unconfirmed exit.
                    if (rootState != WaitObject && rootState != WaitTimeout)
                        return TerminationUnconfirmed;
                    if (rootState == WaitObject)
                    {
                        uint exitCode;
                        if (!Native.GetExitCodeProcess(worker.Process, out exitCode))
                            return TerminationUnconfirmed;
                        if (clock.ElapsedMilliseconds >= deadlineMs)
                            return StopJob(job, worker.Process, DeadlineStopped);
                        return exitCode == 0 ? 0 : WorkerFailed;
                    }
                }
                uint observedParent = Native.WaitForSingleObject(parent, (uint)Math.Min(left, 25));
                if (observedParent != WaitTimeout)
                    return StopForParent(job, worker.Process, observedParent);
            }
        }
        catch (Exception)
        {
            // The reported result deliberately contains no process arguments or paths.
            if (worker.Process == IntPtr.Zero) return SetupRefused;
            return StopJob(job, worker.Process, TerminationUnconfirmed);
        }
        finally
        {
            Close(worker.Thread);
            Close(worker.Process);
            Close(job);
            Close(parent);
        }
    }

    private static bool IsAbsoluteLocalPath(string path)
    {
        if (path.Length < 3 || path[1] != ':' || path[2] != Path.DirectorySeparatorChar)
            return false;
        char drive = Char.ToUpperInvariant(path[0]);
        return drive >= 'A' && drive <= 'Z' && Path.IsPathRooted(Path.GetFullPath(path));
    }

    private static IntPtr OpenLiveParent(uint expected)
    {
        uint observed = 0;
        IntPtr snapshot = Native.CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) return IntPtr.Zero;
        try
        {
            var entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (Native.Process32First(snapshot, ref entry))
            {
                uint self = Native.GetCurrentProcessId();
                do
                {
                    if (entry.ProcessId != self) continue;
                    observed = entry.ParentId;
                    break;
                } while (Native.Process32Next(snapshot, ref entry));
            }
        }
        finally { Close(snapshot); }
        if (observed == 0 || observed != expected) return IntPtr.Zero;
        IntPtr parent = Native.OpenProcess(SynchronizeAndQuery, false, observed);
        if (parent == IntPtr.Zero) return IntPtr.Zero;

        long born, parentBorn, ignoredExit, ignoredKernel, ignoredUser;
        if (Native.GetProcessTimes(Native.GetCurrentProcess(), out born, out ignoredExit, out ignoredKernel, out ignoredUser) &&
            Native.GetProcessTimes(parent, out parentBorn, out ignoredExit, out ignoredKernel, out ignoredUser) &&
            parentBorn < born && ParentAlive(parent))
            return parent;
        Close(parent);
        return IntPtr.Zero;
    }

    private static bool ParentAlive(IntPtr parent)
    {
        return Native.WaitForSingleObject(parent, 0) == WaitTimeout;
    }

    private static bool TryActiveProcesses(IntPtr job, out uint active)
    {
        JobAccounting report;
        bool ok = Native.QueryInformationJobObject(
            job, JobAccountingClass, out report, (uint)Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero);
        active = report.ActiveProcesses;
        return ok;
    }

    private static int StopForParent(IntPtr job, IntPtr root, uint wait)
    {
        return StopJob(job, root, wait == WaitObject ? ParentStopped : TerminationUnconfirmed);
    }

    private static int StopJob(IntPtr job, IntPtr root, int result)
    {
        if (job == IntPtr.Zero || !Native.TerminateJobObject(job, 1))
            return TerminationUnconfirmed;
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 10000)
        {
            uint active;
            if (!TryActiveProcesses(job, out active)) return TerminationUnconfirmed;
            if (active == 0 && Native.WaitForSingleObject(root, 0) == WaitObject) return result;
            Thread.Sleep(25);
        }
        return TerminationUnconfirmed;
    }

    // Failed membership verification leaves the exact root suspended. It has
    // never run a command or had a chance to create any descendant.
    private static int StopSuspendedWorker(IntPtr worker)
    {
        return Native.TerminateProcess(worker, 1) &&
            Native.WaitForSingleObject(worker, 10000) == WaitObject
            ? SetupRefused : TerminationUnconfirmed;
    }

    private static Worker StartWorker(IntPtr job, string[] args)
    {
        var handles = new IntPtr[3];
        IntPtr attributes = IntPtr.Zero, handleList = IntPtr.Zero, jobList = IntPtr.Zero;
        bool initialized = false;
        try
        {
            IntPtr self = Native.GetCurrentProcess();
            for (int i = 0; i < handles.Length; i++)
            {
                IntPtr source = Native.GetStdHandle(-10 - i);
                if (source == IntPtr.Zero || source == new IntPtr(-1) ||
                    !Native.DuplicateHandle(self, source, self, out handles[i], 0, true, 2))
                    return new Worker();
            }
            IntPtr bytes = IntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
            if (bytes == IntPtr.Zero) return new Worker();
            attributes = Marshal.AllocHGlobal(bytes);
            if (!Native.InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes))
                return new Worker();
            initialized = true;
            handleList = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
            for (int i = 0; i < handles.Length; i++)
                Marshal.WriteIntPtr(handleList, IntPtr.Size * i, handles[i]);
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateAttribute(attributes, AttributeHandleList, handleList, IntPtr.Size * handles.Length) ||
                !UpdateAttribute(attributes, AttributeJobList, jobList, IntPtr.Size))
                return new Worker();

            var startup = new ExtendedStartup();
            startup.Info.Size = (uint)Marshal.SizeOf(typeof(ExtendedStartup));
            startup.Info.Flags = 0x00000100; // STARTF_USESTDHANDLES
            startup.Info.Input = handles[0];
            startup.Info.Output = handles[1];
            startup.Info.Error = handles[2];
            startup.Attributes = attributes;
            var command = new StringBuilder(Quote(args[2]));
            for (int i = 4; i < args.Length; i++)
                command.Append(' ').Append(Quote(args[i]));
            if (command.Length >= 32767) return new Worker();
            Worker worker;
            return Native.CreateProcess(args[2], command, IntPtr.Zero, IntPtr.Zero, true,
                CreationFlags, IntPtr.Zero, args[3], ref startup, out worker) ? worker : new Worker();
        }
        finally
        {
            if (initialized) Native.DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            foreach (IntPtr handle in handles) Close(handle);
        }
    }

    private static bool UpdateAttribute(IntPtr list, int attribute, IntPtr value, int size)
    {
        return Native.UpdateProcThreadAttribute(list, 0, new IntPtr(attribute), value,
            new IntPtr(size), IntPtr.Zero, IntPtr.Zero);
    }

    // The Windows CRT treats backslashes before a quote or closing delimiter
    // specially. All other characters pass literally to CreateProcessW.
    private static string Quote(string argument)
    {
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\') { slashes++; continue; }
            quoted.Append('\\', c == '"' ? 2 * slashes + 1 : slashes);
            quoted.Append(c);
            slashes = 0;
        }
        return quoted.Append('\\', 2 * slashes).Append('"').ToString();
    }

    private static void Close(IntPtr handle)
    {
        if (handle != IntPtr.Zero) Native.CloseHandle(handle);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        internal long ProcessTime, JobTime;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperations, WriteOperations, OtherOperations;
        internal ulong ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        internal BasicLimits Basic;
        internal IoCounters Io;
        internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobAccounting
    {
        internal long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        internal uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        internal uint Size, Usage, ProcessId;
        internal UIntPtr Heap;
        internal uint ModuleId, Threads, ParentId;
        internal int Priority;
        internal uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        internal string Image;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Startup
    {
        internal uint Size;
        internal IntPtr Reserved, Desktop, Title;
        internal uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        internal ushort Show, ReservedSize;
        internal IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedStartup { internal Startup Info; internal IntPtr Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Worker { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }

    private static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateJobObject(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetInformationJobObject(IntPtr job, uint kind, ref JobLimits limits, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool QueryInformationJobObject(IntPtr job, uint kind, out JobAccounting report, uint size, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity,
            IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory,
            ref ExtendedStartup startup, out Worker worker);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
            IntPtr size, IntPtr oldValue, IntPtr oldSize);
        [DllImport("kernel32.dll")]
        internal static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GetStdHandle(int kind);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
            out IntPtr target, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr value, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")]
        internal static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")]
        internal static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll")]
        internal static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool CloseHandle(IntPtr handle);
    }
}
