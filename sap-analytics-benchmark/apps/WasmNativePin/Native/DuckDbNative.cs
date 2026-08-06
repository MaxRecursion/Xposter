using System.Runtime.InteropServices;

namespace WasmNativePin.Native;

/// <summary>
/// P/Invoke surface for DuckDB compiled with .NET's Emscripten 3.1.56 and linked via NativeFileReference.
/// </summary>
internal static class DuckDbNative
{
    private const string Lib = "duckdb_native";

    [DllImport(Lib, EntryPoint = "duckdb_bridge_open", CallingConvention = CallingConvention.Cdecl)]
    private static extern int BridgeOpen(out IntPtr error);

    [DllImport(Lib, EntryPoint = "duckdb_bridge_close", CallingConvention = CallingConvention.Cdecl)]
    private static extern void BridgeClose();

    [DllImport(Lib, EntryPoint = "duckdb_bridge_load_csv", CallingConvention = CallingConvention.Cdecl)]
    private static extern int BridgeLoadCsv(IntPtr table, IntPtr data, nuint len, out IntPtr error);

    [DllImport(Lib, EntryPoint = "duckdb_bridge_query_json", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr BridgeQueryJson(IntPtr sql, out IntPtr error);

    [DllImport(Lib, EntryPoint = "duckdb_bridge_free", CallingConvention = CallingConvention.Cdecl)]
    private static extern void BridgeFree(IntPtr ptr);

    public static void Open()
    {
        var rc = BridgeOpen(out var err);
        ThrowIfError(rc, err, "duckdb_bridge_open");
    }

    public static void Close() => BridgeClose();

    public static void LoadCsv(string table, byte[] csvBytes)
    {
        var tablePtr = Marshal.StringToCoTaskMemUTF8(table);
        var dataPtr = Marshal.AllocHGlobal(csvBytes.Length);
        try
        {
            Marshal.Copy(csvBytes, 0, dataPtr, csvBytes.Length);
            var rc = BridgeLoadCsv(tablePtr, dataPtr, (nuint)csvBytes.Length, out var err);
            ThrowIfError(rc, err, $"load_csv({table})");
        }
        finally
        {
            Marshal.FreeHGlobal(dataPtr);
            Marshal.FreeCoTaskMem(tablePtr);
        }
    }

    public static string QueryJson(string sql)
    {
        var sqlPtr = Marshal.StringToCoTaskMemUTF8(sql);
        IntPtr jsonPtr = IntPtr.Zero;
        try
        {
            jsonPtr = BridgeQueryJson(sqlPtr, out var err);
            if (jsonPtr == IntPtr.Zero)
            {
                ThrowIfError(-1, err, "query");
                throw new InvalidOperationException("Native query returned null.");
            }

            if (err != IntPtr.Zero)
                BridgeFree(err);

            return Marshal.PtrToStringUTF8(jsonPtr)
                ?? throw new InvalidOperationException("Native query returned empty JSON.");
        }
        finally
        {
            if (jsonPtr != IntPtr.Zero)
                BridgeFree(jsonPtr);
            Marshal.FreeCoTaskMem(sqlPtr);
        }
    }

    /// <summary>Smoke-test that native symbols resolve and open an in-memory DB.</summary>
    public static string TryResolveSymbols()
    {
        try
        {
            Open();
            return "OK — duckdb_bridge_open resolved and in-memory DB opened (Emscripten 3.1.56).";
        }
        catch (DllNotFoundException ex)
        {
            return $"DllNotFoundException: {ex.Message}";
        }
        catch (EntryPointNotFoundException ex)
        {
            return $"EntryPointNotFoundException: {ex.Message}";
        }
        catch (Exception ex)
        {
            return $"{ex.GetType().Name}: {ex.Message}";
        }
    }

    private static void ThrowIfError(int rc, IntPtr err, string op)
    {
        if (rc == 0 && err == IntPtr.Zero)
            return;

        string message;
        try
        {
            message = err != IntPtr.Zero
                ? Marshal.PtrToStringUTF8(err) ?? $"{op} failed"
                : $"{op} failed (rc={rc})";
        }
        finally
        {
            if (err != IntPtr.Zero)
                BridgeFree(err);
        }

        if (rc != 0 || err != IntPtr.Zero)
            throw new InvalidOperationException($"Native DuckDB {message}");
    }
}
