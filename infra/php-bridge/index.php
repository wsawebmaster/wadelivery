<?php
/**
 * Bridge opcional legado (mysqli). Stack principal usa PostgreSQL via APIs .NET.
 * A API C# pode chamar este endpoint com header X-Api-Key.
 * Ajuste DB_* e API_KEY antes de publicar.
 */
header('Content-Type: application/json; charset=utf-8');

$apiKey = getenv('BRIDGE_API_KEY') ?: 'change-me';
if (($_SERVER['HTTP_X_API_KEY'] ?? '') !== $apiKey) {
    http_response_code(401);
    echo json_encode(['error' => 'unauthorized']);
    exit;
}

$mysqli = new mysqli(
    getenv('DB_HOST') ?: 'localhost',
    getenv('DB_USER') ?: 'delivery',
    getenv('DB_PASS') ?: 'delivery',
    getenv('DB_NAME') ?: 'delivery_catalog'
);

if ($mysqli->connect_errno) {
    http_response_code(500);
    echo json_encode(['error' => 'db_connection_failed']);
    exit;
}

$path = $_GET['resource'] ?? 'health';
if ($path === 'health') {
    echo json_encode(['status' => 'ok', 'bridge' => 'php-mysql']);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'not_found', 'hint' => 'Extend this bridge as needed']);
