<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/bootstrap.php';

try {
    socle_cli($argv);
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . "\n");
    exit(1);
}
