<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/bootstrap.php';

$raw = stream_get_contents(STDIN);
$in = json_decode($raw === false ? '' : $raw, true);
if (!is_array($in)) {
    fwrite(STDERR, "demande refusée\n");
    exit(1);
}
$runtime = [
    'publicOrigin' => null,
    'publicKey' => $in['publicKey'] ?? null,
    'privateKey' => $in['privateKey'] ?? null,
    'subject' => $in['subject'] ?? null,
    'mailer' => null,
];
$request = socle_build_push($in['target'], (string) $in['text'], $runtime, new DateTimeImmutable((string) $in['now']));
fwrite(STDOUT, $request['body']);
