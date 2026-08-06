using System.Security.Cryptography;
using System.Text.Json;
using SapAnalytics.Core.Manifest;

namespace SapAnalytics.Data.Manifest;

public static class ManifestParser
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true
    };

    public static SnapshotManifest Parse(string json)
    {
        var manifest = JsonSerializer.Deserialize<SnapshotManifest>(json, Options)
            ?? throw new InvalidOperationException("Manifest JSON deserialized to null.");
        ValidateStructure(manifest);
        return manifest;
    }

    public static void ValidateStructure(SnapshotManifest manifest)
    {
        if (string.IsNullOrWhiteSpace(manifest.Version))
            throw new InvalidOperationException("Manifest version is required.");

        if (string.IsNullOrWhiteSpace(manifest.SchemaVersion))
            throw new InvalidOperationException("Manifest schemaVersion is required.");

        if (manifest.Tables is null || manifest.Tables.Count == 0)
            throw new InvalidOperationException("Manifest must include at least one table file.");

        foreach (var table in manifest.Tables)
        {
            if (string.IsNullOrWhiteSpace(table.EntityId))
                throw new InvalidOperationException("Table entityId is required.");

            if (string.IsNullOrWhiteSpace(table.FileName))
                throw new InvalidOperationException($"Table {table.EntityId}: fileName is required.");

            if (string.IsNullOrWhiteSpace(table.ChecksumSha256))
                throw new InvalidOperationException($"Table {table.EntityId}: checksumSha256 is required.");

            if (table.ByteSize < 0 || table.RowCount < 0)
                throw new InvalidOperationException($"Table {table.EntityId}: byteSize and rowCount must be non-negative.");
        }
    }
}

public static class ManifestValidator
{
    public static bool VerifyChecksum(byte[] data, string expectedSha256Hex)
    {
        var hash = SHA256.HashData(data);
        var hex = Convert.ToHexString(hash);
        return hex.Equals(expectedSha256Hex, StringComparison.OrdinalIgnoreCase);
    }

    public static void VerifyTableFile(SnapshotTableFile table, byte[] data)
    {
        if (data.Length != table.ByteSize)
            throw new InvalidOperationException(
                $"Table {table.EntityId}: expected {table.ByteSize} bytes, got {data.Length}.");

        if (!VerifyChecksum(data, table.ChecksumSha256))
            throw new InvalidOperationException($"Table {table.EntityId}: checksum mismatch.");
    }
}
