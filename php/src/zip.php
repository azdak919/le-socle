<?php
declare(strict_types=1);

function socle_crc32(string $data): int {
    return (int) hexdec(hash('crc32b', $data));
}

function socle_zip_store(array $files, ?DateTimeImmutable $date = null): string {
    $date ??= new DateTimeImmutable('2026-01-01 00:00:00');
    $time = (($date->format('G') << 11) | ((int) $date->format('i') << 5) | ((int) $date->format('s') >> 1)) & 0xffff;
    $day = (((int) $date->format('Y') - 1980) << 9) | ((int) $date->format('n') << 5) | (int) $date->format('j');
    $locals = '';
    $centrals = '';
    $offset = 0;
    $count = 0;
    foreach ($files as $file) {
        $name = (string) $file['name'];
        $data = (string) $file['data'];
        if (str_contains($name, '..') || str_starts_with($name, '/') || str_contains($name, '\\')) {
            throw new RuntimeException('chemin refusé : ' . $name);
        }
        $crc = socle_crc32($data);
        $nameLen = strlen($name);
        $size = strlen($data);
        $local = pack('VvvvvvVVVvv', 0x04034b50, 20, 0, 0, $time, $day, $crc, $size, $size, $nameLen, 0) . $name . $data;
        $central = pack('VvvvvvVVVvvvvvVV', 0x02014b50, 20, 20, 0, $time, $day, $crc, $size, $size, $nameLen, 0, 0, 0, 0, 0, $offset) . $name;
        $locals .= $local;
        $centrals .= $central;
        $offset += strlen($local);
        $count += 1;
    }
    $centralSize = strlen($centrals);
    $eocd = pack('VvvvvVVv', 0x06054b50, 0, 0, $count, $count, $centralSize, $offset, 0);
    return $locals . $centrals . $eocd;
}

function socle_unzip(string $data): array {
    $files = [];
    $offset = 0;
    $length = strlen($data);
    while ($offset + 4 <= $length) {
        $signature = unpack('V', substr($data, $offset, 4))[1];
        if ($signature !== 0x04034b50) break;
        $method = unpack('v', substr($data, $offset + 8, 2))[1];
        $size = unpack('V', substr($data, $offset + 18, 4))[1];
        $nameLength = unpack('v', substr($data, $offset + 26, 2))[1];
        $extra = unpack('v', substr($data, $offset + 28, 2))[1];
        $name = substr($data, $offset + 30, $nameLength);
        if ($method !== 0) throw new RuntimeException('compression non lue : ' . $name);
        if (str_contains($name, '..') || str_starts_with($name, '/') || str_contains($name, '\\')) {
            throw new RuntimeException('chemin refusé : ' . $name);
        }
        $start = $offset + 30 + $nameLength + $extra;
        $files[$name] = substr($data, $start, $size);
        $offset = $start + $size;
    }
    return $files;
}

function socle_text_file(string $name, string $text): array {
    return ['name' => $name, 'data' => $text];
}
