import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'app_scope.dart';
import 'diagnostic.dart';
import 'history_chart.dart';
import 'sample_repository.dart';
import 'request_feedback.dart';
import 'tracker_repository.dart';

const sampleNotice = 'Sample mode • Changes reset on restart';

class SamplePage extends StatelessWidget {
  const SamplePage({
    super.key,
    required this.title,
    required this.child,
    this.actions,
    this.fab,
  });
  final String title;
  final Widget child;
  final List<Widget>? actions;
  final Widget? fab;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(title), actions: actions),
    floatingActionButton: fab,
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                color: Theme.of(context).colorScheme.secondary,
                padding: const EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: 12,
                ),
                child: Text(
                  TrackerAppScope.isSample(context)
                      ? sampleNotice
                      : 'API mode • Private account data',
                  style: const TextStyle(fontSize: 12),
                ),
              ),
              Expanded(child: child),
            ],
          ),
        ),
      ),
    ),
  );
}

class PageList extends StatelessWidget {
  const PageList({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(20, 24, 20, 104),
    children: children
        .expand((child) => [child, const SizedBox(height: 20)])
        .toList(),
  );
}

class ErrorMessage extends StatelessWidget {
  const ErrorMessage(this.message, {super.key});
  final String message;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Text(
      message,
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    ),
  );
}

class GameCover extends StatelessWidget {
  const GameCover(this.product, {super.key});
  final Product product;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: Image.asset(
        product.artwork,
        width: 64,
        height: 80,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => const SizedBox(
          width: 64,
          height: 80,
          child: Icon(Icons.sports_esports_outlined, size: 32),
        ),
      ),
    ),
  );
}

String priceLabel(Product product) => product.price == null
    ? 'Steam price unavailable'
    : 'Last known ${product.price!.formatted} USD';
String dateLabel(DateTime? date) => date == null
    ? 'Not available'
    : '${date.toUtc().toIso8601String().substring(0, 16).replaceAll('T', ' ')} UTC';

class WatchlistScreen extends StatefulWidget {
  const WatchlistScreen({super.key, required this.repository, this.api});
  final TrackerRepository repository;
  final HealthApi? api;
  @override
  State<WatchlistScreen> createState() => _WatchlistScreenState();
}

class _WatchlistScreenState extends State<WatchlistScreen>
    with RequestCooldown<WatchlistScreen> {
  final _search = TextEditingController();
  Timer? _searchTimer;
  late Future<List<Tracker>> _items;
  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() {
    _items = _fetch(() => widget.repository.list(search: _search.text));
    // Cached failures can complete before FutureBuilder subscribes next frame.
    _items.ignore();
  }

  Future<List<Tracker>> _fetch(Future<List<Tracker>> Function() load) async {
    try {
      return await load();
    } catch (error) {
      if (mounted) setState(() => coolDown(error));
      rethrow;
    }
  }

  @override
  void dispose() {
    _search.dispose();
    _searchTimer?.cancel();
    super.dispose();
  }

  Future<void> _open(Widget screen) async {
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => screen));
    if (mounted) {
      setState(_reload);
    }
  }

  Widget _results(AsyncSnapshot<List<Tracker>> snapshot) {
    if (snapshot.connectionState != ConnectionState.done) {
      return Column(
        children: [
          const LinearProgressIndicator(),
          const SizedBox(height: 16),
          Text(
            TrackerAppScope.isSample(context)
                ? 'Loading sample watchlist…'
                : 'Loading watchlist…',
          ),
        ],
      );
    }
    if (snapshot.hasError) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ErrorMessage(snapshot.error.toString()),
          TextButton(
            onPressed: retrySeconds > 0 ? null : () => setState(_reload),
            child: Text(
              retrySeconds > 0
                  ? 'Try again in $retrySeconds seconds'
                  : 'Try again',
            ),
          ),
          if (snapshot.error is RepositoryException &&
              (snapshot.error as RepositoryException).expired)
            TextButton(
              onPressed: () =>
                  _open(AccountScreen(repository: widget.repository)),
              child: const Text('Go to account'),
            ),
        ],
      );
    }
    final items = snapshot.data!;
    if (items.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            _search.text.trim().isEmpty
                ? 'Your next game starts here.'
                : 'No saved games match.',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 12),
          Text(
            _search.text.trim().isEmpty
                ? 'Tap Add game and paste a supported Steam link.'
                : 'Try a different title or clear your search.',
          ),
          if (_search.text.isNotEmpty)
            TextButton(
              onPressed: () {
                _search.clear();
                setState(_reload);
              },
              child: const Text('Clear search'),
            ),
        ],
      );
    }
    return Column(
      children: items
          .map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Card(
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () => _open(
                    DetailScreen(
                      repository: widget.repository,
                      trackerId: item.id,
                    ),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        GameCover(item.product),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                item.product.title,
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              const SizedBox(height: 8),
                              Text(priceLabel(item.product)),
                              const SizedBox(height: 8),
                              Text('Target ${item.targetPrice.formatted} USD'),
                              const SizedBox(height: 8),
                              Text(
                                item.enabled
                                    ? (TrackerAppScope.isSample(context)
                                          ? 'Tracking • Dated sample'
                                          : 'Tracking • ${item.product.freshness}')
                                    : (TrackerAppScope.isSample(context)
                                          ? 'Paused • Dated sample'
                                          : 'Paused'),
                                style: TextStyle(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          )
          .toList(),
    );
  }

  @override
  Widget build(BuildContext context) => SamplePage(
    title: 'Watchlist',
    actions: [
      IconButton(
        tooltip: 'Account and settings',
        icon: const Icon(Icons.person_outline),
        onPressed: () => _open(
          AccountScreen(repository: widget.repository, api: widget.api),
        ),
      ),
    ],
    fab: FloatingActionButton.extended(
      onPressed: () => _open(TrackerEditor(repository: widget.repository)),
      icon: const Icon(Icons.add),
      label: const Text('Add game'),
    ),
    child: FutureBuilder<List<Tracker>>(
      future: _items,
      builder: (context, snapshot) => PageList(
        children: [
          Text(
            'Good games.\nYour price.',
            style: Theme.of(context).textTheme.headlineMedium
                ?.copyWith(fontWeight: FontWeight.w600),
          ),
          Text(
            TrackerAppScope.isSample(context)
                ? 'Steam base games, US / USD. These dated examples are not live quotes.'
                : 'Your saved Steam base games • US / USD.',
          ),
          TextField(
            controller: _search,
            onChanged: (_) {
              _searchTimer?.cancel();
              if (TrackerAppScope.isSample(context)) {
                setState(_reload);
              } else {
                _searchTimer = Timer(const Duration(milliseconds: 350), () {
                  if (mounted) setState(_reload);
                });
              }
            },
            decoration: const InputDecoration(
              labelText: 'Search saved games',
              prefixIcon: Icon(Icons.search),
            ),
          ),
          _results(snapshot),
          if (snapshot.connectionState == ConnectionState.done &&
              !snapshot.hasError &&
              widget.repository is PagedTrackerRepository &&
              (widget.repository as PagedTrackerRepository).hasMore)
            TextButton(
              onPressed: retrySeconds > 0
                  ? null
                  : () => setState(() {
                      _items = _fetch(
                        (widget.repository as PagedTrackerRepository).loadMore,
                      );
                      _items.ignore();
                    }),
              child: const Text('Load more games'),
            ),
          Text(
            TrackerAppScope.isSample(context)
                ? 'Prices via CheapShark. Not affiliated with Steam. No price checks or alerts run in sample mode.'
                : 'Prices via CheapShark. Not affiliated with Steam. Failed checks retain the last successful price; daily checks run on the server when configured.',
            style: const TextStyle(fontSize: 12),
          ),
        ],
      ),
    ),
  );
}

class TrackerEditor extends StatefulWidget {
  const TrackerEditor({super.key, required this.repository, this.tracker});
  final TrackerRepository repository;
  final Tracker? tracker;
  @override
  State<TrackerEditor> createState() => _TrackerEditorState();
}

class _TrackerEditorState extends State<TrackerEditor>
    with RequestCooldown<TrackerEditor> {
  final _url = TextEditingController();
  final _target = TextEditingController();
  ProductPreview? _preview;
  bool _enabled = true, _email = true, _push = false, _busy = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    final item = widget.tracker;
    if (item != null) {
      _target.text = item.targetPrice.input;
      _enabled = item.enabled;
      _email = item.alerts.email;
      _push = item.alerts.push;
    }
  }

  @override
  void dispose() {
    _url.dispose();
    _target.dispose();
    super.dispose();
  }

  Future<void> _lookup() async {
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final preview = await widget.repository.preview(_url.text);
      if (mounted) {
        setState(() => _preview = preview);
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = requestMessage(error);
          coolDown(error);
        });
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  Future<void> _save() async {
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final target = Money.parse(_target.text);
      final alerts = AlertPreferences(email: _email, push: _push);
      if (widget.tracker == null) {
        await widget.repository.create(
          previewId: _preview!.id,
          targetPrice: target,
          enabled: _enabled,
          alerts: alerts,
        );
      } else {
        await widget.repository.update(
          widget.tracker!.id,
          targetPrice: target,
          enabled: _enabled,
          alerts: alerts,
        );
      }
      if (mounted) {
        Navigator.of(context).pop();
      }
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is FormatException
              ? error.message
              : requestMessage(error),
        );
        coolDown(error);
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final product = widget.tracker?.product ?? _preview?.product;
    return PopScope(
      canPop: !_busy,
      child: SamplePage(
        title: widget.tracker == null ? 'Add game' : 'Edit tracker',
        child: PageList(
          children: [
            if (product == null) ...[
              Text(
                'Start with a Steam link.',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              Text(
                TrackerAppScope.isSample(context)
                    ? 'Local sample preview only. Supports Portal 2 and Half-Life 2; submitted links are never fetched.'
                    : 'Preview an exact supported Steam base-game offer through the API. Unknown editions, DLC and bundles are unsupported. Submitted links are never fetched directly.',
              ),
              TextField(
                controller: _url,
                enabled: !_busy,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  labelText: 'Steam game URL',
                  hintText: 'https://store.steampowered.com/app/620/',
                ),
              ),
              Wrap(
                spacing: 8,
                children: [
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => _url.text =
                              'https://store.steampowered.com/app/620/',
                    child: const Text('Use Portal 2 link'),
                  ),
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => _url.text =
                              'https://store.steampowered.com/app/220/',
                    child: const Text('Use Half-Life 2 link'),
                  ),
                ],
              ),
              FilledButton(
                onPressed: _busy || retrySeconds > 0 ? null : _lookup,
                child: const Text('Preview game'),
              ),
            ] else ...[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  GameCover(product),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          product.title,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        Text(priceLabel(product)),
                        const Text('Steam • US / USD'),
                      ],
                    ),
                  ),
                ],
              ),
              Text(
                TrackerAppScope.isSample(context)
                    ? 'October 26, 2026 source proof via CheapShark. Not a current quote.'
                    : '${product.attribution}\nLast successful observation: ${dateLabel(product.observedAt)}\nFreshness: ${product.freshness}',
              ),
              if (!TrackerAppScope.isSample(context) &&
                  product.lastError != null)
                ErrorMessage(product.lastError!),
              if (widget.tracker == null)
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => setState(() {
                          _preview = null;
                          _error = null;
                        }),
                  child: const Text('Change link'),
                ),
              TextField(
                controller: _target,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: const InputDecoration(
                  labelText: 'Target price (USD)',
                  prefixText: '\$ ',
                  helperText: 'Zero is valid. Up to two decimal places.',
                ),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Tracking enabled'),
                value: _enabled,
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _enabled = value),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Email preference'),
                subtitle: Text(
                  TrackerAppScope.isSample(context)
                      ? 'Sample only. No email is sent.'
                      : 'Save this tracker’s email alert preference.',
                ),
                value: _email,
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _email = value),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Android push preference'),
                subtitle: const Text(
                  'Device unavailable. Saving this preference does not enable delivery.',
                ),
                value: _push,
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _push = value),
              ),
              const Text(
                'Changing a target does not change a game’s price or history, or demonstrate an actual price drop.',
              ),
              FilledButton(
                onPressed: _busy || retrySeconds > 0 ? null : _save,
                child: Text(
                  widget.tracker == null ? 'Save tracker' : 'Save changes',
                ),
              ),
            ],
            if (_busy)
              Semantics(
                liveRegion: true,
                child: const LinearProgressIndicator(),
              ),
            if (_error != null) ErrorMessage(_error!),
            if (retrySeconds > 0) Text('Try again in $retrySeconds seconds.'),
            TextButton(
              onPressed: _busy ? null : () => Navigator.of(context).pop(),
              child: const Text('Cancel'),
            ),
          ],
        ),
      ),
    );
  }
}

class DetailScreen extends StatefulWidget {
  const DetailScreen({
    super.key,
    required this.repository,
    required this.trackerId,
  });
  final TrackerRepository repository;
  final String trackerId;
  @override
  State<DetailScreen> createState() => _DetailScreenState();
}

class _DetailScreenState extends State<DetailScreen>
    with RequestCooldown<DetailScreen> {
  late Future<(Tracker, List<Observation>)> _detail;
  bool _busy = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() {
    _detail = _load();
    _detail.ignore();
  }

  Future<(Tracker, List<Observation>)> _load() async {
    try {
      final item = await widget.repository.get(widget.trackerId);
      return (item, await widget.repository.history(widget.trackerId));
    } catch (error) {
      if (mounted) setState(() => coolDown(error));
      rethrow;
    }
  }

  Future<void> _remove() async {
    final confirmed = await showDialog<bool>(
      context: context,
      useRootNavigator: false,
      builder: (context) => AlertDialog(
        title: const Text('Remove tracker?'),
        content: Text(
          TrackerAppScope.isSample(context)
              ? 'This removes the saved target and preferences from this sample watchlist.'
              : 'This removes your saved tracker, target and preferences. It does not remove the shared game metadata.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep tracker'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.repository.delete(widget.trackerId);
      if (mounted) {
        Navigator.of(context).pop();
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = requestMessage(error);
          coolDown(error);
        });
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  Future<void> _purchase(Product product) async {
    final url = product.purchaseUrl;
    if (url == null || !isSafePurchaseUrl(url)) {
      return;
    }
    await showDialog<void>(
      context: context,
      useRootNavigator: false,
      builder: (context) => AlertDialog(
        title: Text(
          TrackerAppScope.isSample(context)
              ? 'Dated purchase link'
              : 'CheapShark purchase link',
        ),
        scrollable: true,
        content: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              TrackerAppScope.isSample(context)
                  ? 'CheapShark redirect from October 26, 2026. It may have expired. Copy it into your browser for human navigation; this app never requests it.'
                  : 'Last observed: ${dateLabel(product.observedAt)}. This ${product.freshness} offer may have changed or expired. Copy the CheapShark redirect into your browser for human navigation; this app never requests it.',
            ),
            const SizedBox(height: 16),
            SelectableText(url.toString()),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: url.toString()));
              if (context.mounted) {
                Navigator.pop(context);
              }
            },
            child: const Text('Copy link'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: SamplePage(
      title: 'Game details',
      child: FutureBuilder(
        future: _detail,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return PageList(
              children: [
                ErrorMessage(snapshot.error.toString()),
                TextButton(
                  onPressed: retrySeconds > 0 ? null : () => setState(_reload),
                  child: Text(
                    retrySeconds > 0
                        ? 'Try again in $retrySeconds seconds'
                        : 'Try again',
                  ),
                ),
              ],
            );
          }
          final (item, history) = snapshot.data!;
          final product = item.product;
          return PageList(
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  GameCover(product),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Text(
                      product.title,
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                  ),
                ],
              ),
              Text(
                priceLabel(product),
                style: Theme.of(context).textTheme.titleLarge,
              ),
              Text(
                'Target ${item.targetPrice.formatted} USD • ${item.enabled ? 'Tracking' : 'Paused'}',
              ),
              Text(
                TrackerAppScope.isSample(context)
                    ? 'Dated sample, not a live quote. Daily checks are planned, not running here.'
                    : 'Last successful Steam offer. Daily checks are server-side; the app does not trigger provider checks.',
              ),
              if (product.lastError != null) ErrorMessage(product.lastError!),
              Text(
                'Steam • US / USD\nSource: ${product.source}\nLast successful observation: ${dateLabel(product.observedAt)}\nProvider change: ${dateLabel(product.providerChangedAt)}\n${TrackerAppScope.isSample(context) ? 'Last failed attempt' : 'Last attempt'}: ${dateLabel(product.lastAttemptAt)}\nFreshness: ${product.freshness}',
              ),
              const Text(
                'Not affiliated with Steam. No cheapest-across-stores substitution.',
              ),
              if (!TrackerAppScope.isSample(context))
                Text(
                  '${product.attribution}\nStale after: ${dateLabel(product.staleAt)}\nNext server check estimate: ${dateLabel(product.nextCheckAt)}',
                ),
              if (product.purchaseUrl != null &&
                  product.price != null &&
                  isSafePurchaseUrl(product.purchaseUrl!))
                OutlinedButton.icon(
                  onPressed: () => _purchase(product),
                  icon: const Icon(Icons.open_in_new),
                  label: const Text('View purchase link'),
                ),
              const Divider(),
              Text(
                TrackerAppScope.isSample(context)
                    ? 'Illustrative sample history'
                    : 'Recorded price observations',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              Text(
                TrackerAppScope.isSample(context)
                    ? 'Invented multi-day values for layout only. Not recorded Steam history or a claim of a sale.'
                    : 'Successful local observations of this exact Steam offer, not a provider historical-low series.',
              ),
              if (widget.repository
                  case final HistoryMetadataRepository repository)
                if (repository.historyMetadataFor(widget.trackerId)
                    case final HistoryMetadata metadata)
                  Text(
                    'Window: ${dateLabel(metadata.from)} to ${dateLabel(metadata.to)} (end exclusive)\nRetained from: ${dateLabel(metadata.retainedFrom)}',
                  ),
              IllustrativeHistoryChart(
                observations: history,
                illustrative: TrackerAppScope.isSample(context),
              ),
              for (final entry in history)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Text(
                    '${dateLabel(entry.observedAt).substring(0, 10)}   ${entry.price.formatted} USD',
                  ),
                ),
              const Divider(),
              Text(
                'Alert preferences',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              Text(
                'Email: ${item.alerts.email ? 'selected' : 'off'}\nAndroid push: ${item.alerts.push ? 'selected' : 'off'}\n${TrackerAppScope.isSample(context) ? 'Device unavailable. No emails or notifications are sent.' : 'Push device not connected. A saved preference does not enable delivery.'}',
              ),
              FilledButton(
                onPressed: _busy
                    ? null
                    : () async {
                        await Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => TrackerEditor(
                              repository: widget.repository,
                              tracker: item,
                            ),
                          ),
                        );
                        if (mounted) {
                          setState(_reload);
                        }
                      },
                child: const Text('Edit target and preferences'),
              ),
              OutlinedButton(
                onPressed: _busy || retrySeconds > 0 ? null : _remove,
                child: const Text('Remove tracker'),
              ),
              if (_busy) const LinearProgressIndicator(),
              if (_error != null) ErrorMessage(_error!),
              if (retrySeconds > 0) Text('Try again in $retrySeconds seconds.'),
            ],
          );
        },
      ),
    ),
  );
}

class AccountScreen extends StatefulWidget {
  const AccountScreen({super.key, required this.repository, this.api});
  final TrackerRepository repository;
  final HealthApi? api;
  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen> {
  String _account = 'Sample account';
  @override
  Widget build(BuildContext context) {
    final scope = TrackerAppScope.maybeOf(context);
    if (scope != null && !scope.sample && scope.accountBuilder != null) {
      return scope.accountBuilder!(context);
    }
    return SamplePage(
      title: 'Account and settings',
      child: PageList(
        children: [
          Text(_account, style: Theme.of(context).textTheme.headlineSmall),
          const Text(
            'demo@example.test\nNo real account, session, security, email, or push service is connected.',
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const AuthPreview()),
            ),
            child: const Text('Preview account flows'),
          ),
          TextButton(
            onPressed: () {
              if (widget.repository
                  case final SampleTrackerRepository repository) {
                repository.reset(empty: true);
              }
              setState(() => _account = 'Sample signed out');
            },
            child: const Text('Preview sign out (clears sample watchlist)'),
          ),
          const Divider(),
          Text('Android push', style: Theme.of(context).textTheme.titleLarge),
          const Text(
            'Device unavailable in this sample. Preferences are visual only. No permission request, Firebase connection, token registration, or delivery is implemented.',
          ),
          if (widget.repository case final SampleTrackerRepository repository)
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: const Text('Sample developer scenarios'),
              subtitle: const Text('Secondary previews; not price checks'),
              children: [
                for (final scenario in SampleScenario.values)
                  ListTile(
                    title: Text(switch (scenario) {
                      SampleScenario.normal => 'Normal / reset sample',
                      SampleScenario.empty => 'Empty watchlist',
                      SampleScenario.offline => 'Offline / save failure',
                      SampleScenario.expired => 'Expired session',
                      SampleScenario.stale =>
                        'Failed check / keep last success',
                      SampleScenario.missingOffer => 'Missing Steam offer',
                    }),
                    onTap: () {
                      if (scenario == SampleScenario.normal ||
                          scenario == SampleScenario.empty) {
                        repository.reset(
                          empty: scenario == SampleScenario.empty,
                        );
                      }
                      repository.scenario = scenario;
                      Navigator.of(context).pop();
                    },
                  ),
              ],
            ),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text('API diagnostic'),
            children: [
              const Text(
                'Explicit health request only; not a price fetch or sample save.',
              ),
              TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => StarterScreen(api: widget.api),
                  ),
                ),
                child: const Text('Open API diagnostic'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class AuthPreview extends StatefulWidget {
  const AuthPreview({super.key});
  @override
  State<AuthPreview> createState() => _AuthPreviewState();
}

class _AuthPreviewState extends State<AuthPreview> {
  String _mode = 'Sign in';
  String? _message;
  @override
  Widget build(BuildContext context) => SamplePage(
    title: _mode,
    child: PageList(
      children: [
        Text(
          'Account flow preview',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const Text(
          'Use only the fixed sample credentials below. No real account is created. Nothing is transmitted or persisted.',
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final mode in [
              'Sign in',
              'Register',
              'Verify email',
              'Forgot password',
              'Reset password',
            ])
              ChoiceChip(
                label: Text(mode),
                selected: _mode == mode,
                onSelected: (_) => setState(() {
                  _mode = mode;
                  _message = null;
                }),
              ),
          ],
        ),
        if (_mode == 'Sign in' || _mode == 'Register') ...[
          const TextField(
            readOnly: true,
            decoration: InputDecoration(
              labelText: 'Sample email',
              hintText: 'demo@example.test',
            ),
          ),
          const TextField(
            readOnly: true,
            obscureText: true,
            decoration: InputDecoration(
              labelText: 'Sample password',
              hintText: 'Not collected in preview',
            ),
          ),
          FilledButton(
            onPressed: () => setState(
              () => _message = _mode == 'Register'
                  ? 'Sample registration preview. In the real app, open your verification email in a browser, verify, then return here to sign in. No email was sent.'
                  : 'Sample sign-in result. No authenticated session was created.',
            ),
            child: Text('Preview ${_mode.toLowerCase()}'),
          ),
          if (_mode == 'Sign in')
            OutlinedButton(
              onPressed: () => setState(
                () => _message = 'Unverified account preview: verify your email in the browser, then return here and sign in. Login is blocked until verification.',
              ),
              child: const Text('Preview unverified account'),
            ),
        ],
        if (_mode == 'Verify email') ...[
          const Text(
            'Open the verification link from your email in a browser. Confirm verification there, return to this app, and sign in. No deep link or automatic login is assumed.',
          ),
          FilledButton(
            onPressed: () => setState(
              () => _message = 'Verification success preview. Return to Sign in. This did not verify a real account.',
            ),
            child: const Text('Preview verification result'),
          ),
          OutlinedButton(
            onPressed: () => setState(
              () => _message = 'Expired-link preview. Request a new verification email in the real app.',
            ),
            child: const Text('Preview expired link'),
          ),
          TextButton(
            onPressed: () => setState(
              () => _message = 'Resend preview only. No email was sent.',
            ),
            child: const Text('Preview resend'),
          ),
        ],
        if (_mode == 'Forgot password' || _mode == 'Reset password') ...[
          const Text(
            'Password reset finishes in your browser. Open the email link, explicitly confirm a new password there, then return here and sign in. This preview never asks for a real password.',
          ),
          FilledButton(
            onPressed: () => setState(
              () => _message = _mode == 'Forgot password'
                  ? 'Preview: if an account exists, the real service would send instructions. No email was sent.'
                  : 'Reset result preview. Return to the app and sign in. No password was changed.',
            ),
            child: const Text('Preview result'),
          ),
          OutlinedButton(
            onPressed: () => setState(
              () => _message =
                  'Expired reset link preview. Request a new reset link.',
            ),
            child: const Text('Preview expired link'),
          ),
        ],
        if (_message != null)
          Semantics(liveRegion: true, child: Text(_message!)),
      ],
    ),
  );
}
