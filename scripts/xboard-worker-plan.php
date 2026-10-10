<?php
/**
 * Run inside an existing XBoard PHP application, as its administrator.
 * Usage: php xboard-worker-plan.php /absolute/path/plan.json [--apply]
 * The default is read-only. --apply creates only the dedicated Worker machine
 * and nodes whose code begins cf-worker-. It never changes another machine.
 * On apply, token_file receives the machine credential with mode 0600.
 * Never commit plan.json or token_file when they contain deployment secrets.
 */
declare(strict_types=1);

use App\Models\Server;
use App\Models\ServerGroup;
use App\Models\ServerMachine;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

final class SafeWorkerPlanException extends RuntimeException {}

const WORKER_OWNER = 'Managed by xboard-cloudflare-optimized-node (Worker-only)';

try {
    $planFile = $argv[1] ?? '';
    $apply = in_array('--apply', array_slice($argv, 2), true);
    if ($planFile === '' || !is_file($planFile)) {
        throw new SafeWorkerPlanException('Usage: php xboard-worker-plan.php plan.json [--apply]');
    }
    $plan = json_decode(file_get_contents($planFile), true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($plan) || !is_array($plan['nodes'] ?? null) || !$plan['nodes']) {
        throw new SafeWorkerPlanException('Plan must contain a non-empty nodes array.');
    }
    $root = getenv('XBOARD_ROOT') ?: getcwd();
    chdir($root);
    require $root . '/vendor/autoload.php';
    $app = require $root . '/bootstrap/app.php';
    $app->make(Kernel::class)->bootstrap();

    $machineName = (string) ($plan['machine_name'] ?? 'Cloudflare Worker');
    if ($machineName === '' || strlen($machineName) > 255) {
        throw new SafeWorkerPlanException('Invalid machine_name.');
    }
    $machine = ServerMachine::where('name', $machineName)->first();
    if ($machine && !$machine->is_active) {
        throw new SafeWorkerPlanException('Worker machine is disabled; enable it explicitly in XBoard first.');
    }
    if ($machine && $machine->notes !== WORKER_OWNER) {
        throw new SafeWorkerPlanException('Existing machine name is not owned by this deployment; choose a new name.');
    }

    $prepared = [];
    $keys = [];
    $hosts = [];
    foreach ($plan['nodes'] as $input) {
        if (!is_array($input) || !is_array($input['group_ids'] ?? null)) {
            throw new SafeWorkerPlanException('Each node needs an object and a group_ids array.');
        }
        if (array_key_exists('show', $input) && !is_bool($input['show'])) {
            throw new SafeWorkerPlanException('Node show must be a JSON boolean.');
        }
        $key = (string) ($input['key'] ?? '');
        $name = (string) ($input['name'] ?? '');
        $host = strtolower((string) ($input['host'] ?? ''));
        $path = (string) ($input['path'] ?? '/vless');
        $groups = array_values(array_unique(array_map('strval', $input['group_ids'] ?? [])));
        $rate = $input['rate'] ?? 1;
        if (!preg_match('/^[a-z][a-z0-9-]{0,47}$/D', $key) || isset($keys[$key])) {
            throw new SafeWorkerPlanException('Every node needs a unique lowercase key.');
        }
        if ($name === '' || strlen($name) > 255) {
            throw new SafeWorkerPlanException('Invalid node name.');
        }
        if (!filter_var($host, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME) || !str_contains($host, '.') || isset($hosts[$host])) {
            throw new SafeWorkerPlanException('Every node needs a unique public hostname.');
        }
        if (!preg_match('~^/[A-Za-z0-9/_-]{1,200}$~D', $path)) {
            throw new SafeWorkerPlanException('Invalid WebSocket path.');
        }
        if (!$groups || ServerGroup::whereIn('id', $groups)->count() !== count($groups)) {
            throw new SafeWorkerPlanException('Every group_ids entry must refer to an existing group.');
        }
        if (!is_numeric($rate) || (float) $rate < 0 || (float) $rate > 999999.99) {
            throw new SafeWorkerPlanException('Invalid traffic rate.');
        }
        $code = 'cf-worker-' . $key;
        $node = Server::where('type', 'vless')->where('code', $code)->first();
        if ($node && (!$machine || $node->machine_id !== $machine->id || !in_array('Cloudflare Worker', $node->tags ?? [], true))) {
            throw new SafeWorkerPlanException('An existing node code belongs to another deployment.');
        }
        // Refuse the original nodes and unrelated node domains, even on apply.
        if (Server::where('host', $host)->when($node, fn($q) => $q->where('id', '!=', $node->id))->exists()) {
            throw new SafeWorkerPlanException('Hostname already belongs to another XBoard node.');
        }
        $fields = [
            'type' => 'vless',
            'code' => $code,
            'parent_id' => null,
            'name' => $name,
            'group_ids' => $groups,
            'route_ids' => [],
            'tags' => ['Cloudflare Worker'],
            'rate' => (float) $rate,
            'rate_time_enable' => false,
            'host' => $host,
            'port' => '443',
            'server_port' => 443,
            'enabled' => true,
            'show' => array_key_exists('show', $input) ? (bool) $input['show'] : ($node ? $node->show : false),
            'protocol_settings' => [
                'tls' => 1,
                'network' => 'ws',
                'flow' => '',
                'network_settings' => ['path' => $path, 'headers' => ['Host' => $host]],
                'tls_settings' => ['server_name' => $host, 'allow_insecure' => false],
                'multiplex' => ['enabled' => false],
                'encryption' => ['enabled' => false],
            ],
        ];
        $prepared[] = ['key' => $key, 'model' => $node, 'fields' => $fields];
        $keys[$key] = true;
        $hosts[$host] = true;
    }

    $tokenPath = null;
    $tokenHandle = null;
    if ($apply) {
        $tokenPath = (string) ($plan['token_file'] ?? '');
        if ($tokenPath === '' || !str_starts_with($tokenPath, '/') || file_exists($tokenPath) || is_link($tokenPath)) {
            throw new SafeWorkerPlanException('--apply requires a new absolute token_file path.');
        }
        umask(0077);
        $tokenHandle = fopen($tokenPath, 'x');
        if (!$tokenHandle || !chmod($tokenPath, 0600)) {
            throw new SafeWorkerPlanException('Cannot create protected token_file.');
        }
        DB::transaction(function () use (&$machine, $machineName, &$prepared) {
            if (!$machine) {
                $machine = ServerMachine::create([
                    'name' => $machineName,
                    'token' => ServerMachine::generateToken(),
                    'notes' => WORKER_OWNER,
                    'is_active' => true,
                ]);
            }
            $nextSort = (int) Server::max('sort') + 1;
            foreach ($prepared as &$entry) {
                $entry['fields']['machine_id'] = $machine->id;
                if ($entry['model']) {
                    $entry['model']->update($entry['fields']);
                } else {
                    $entry['fields']['sort'] = $nextSort++;
                    $entry['model'] = Server::create($entry['fields']);
                }
            }
        });
        $credentials = ['machine_id' => $machine->id, 'token' => $machine->getRawOriginal('token')];
        $encoded = json_encode($credentials, JSON_THROW_ON_ERROR) . "\n";
        if (fwrite($tokenHandle, $encoded) !== strlen($encoded)) {
            throw new SafeWorkerPlanException('Machine was created, but credential export failed; inspect protected token_file.');
        }
        fclose($tokenHandle);
    }

    $result = [
        'mode' => $apply ? 'applied' : 'read-only plan',
        'machine_id' => $machine?->id,
        'machine_name' => $machineName,
        'credential_file' => $tokenPath,
        'nodes' => array_map(fn($entry) => [
            'key' => $entry['key'],
            'id' => $entry['model']?->id,
            'name' => $entry['fields']['name'],
            'host' => $entry['fields']['host'],
            'path' => $entry['fields']['protocol_settings']['network_settings']['path'],
            'show' => $entry['fields']['show'],
            'rate' => $entry['fields']['rate'],
        ], $prepared),
    ];
    echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
} catch (Throwable $e) {
    // The message contains validation details only; never echo machine secrets.
    fwrite(STDERR, ($e instanceof SafeWorkerPlanException ? $e->getMessage() : 'XBoard operation failed (' . get_class($e) . '); inspect the panel locally.') . "\n");
    exit(1);
}
