import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'api.dart';

void main() {
  runApp(const PriceTrackerApp());
}

class PriceTrackerApp extends StatelessWidget {
  const PriceTrackerApp({super.key, this.api});

  final HealthApi? api;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Price Tracker',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.teal,
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: StarterScreen(api: api),
    );
  }
}

class StarterScreen extends StatefulWidget {
  const StarterScreen({super.key, this.api});

  final HealthApi? api;

  @override
  State<StarterScreen> createState() => _StarterScreenState();
}

class _StarterScreenState extends State<StarterScreen> {
  http.Client? _ownedClient;
  late final HealthApi _api;
  bool _busy = false;
  String _message = 'Not checked yet.';

  @override
  void initState() {
    super.initState();

    // Tests can supply an API. Otherwise, this screen owns the HTTP client.
    if (widget.api != null) {
      _api = widget.api!;
    } else {
      _ownedClient = http.Client();
      _api = HealthApi(client: _ownedClient!);
    }
  }

  @override
  void dispose() {
    // Leave injected clients alone; close only the one this screen created.
    _ownedClient?.close();

    super.dispose();
  }

  Future<void> _checkConnection() async {
    setState(() {
      _busy = true;
      _message = 'Contacting the API…';
    });

    try {
      final health = await _api.getHealth();

      // The request may finish after the user has left this screen.
      if (!mounted) {
        return;
      }

      setState(() {
        _message =
            'API is online. Database: ${health.database.replaceAll('_', ' ')}.'
            '${health.database == 'connected' ? '' : ' Persistence is not ready.'}';
      });
    } catch (_) {
      if (!mounted) {
        return;
      }

      setState(() {
        _message = 'Could not reach the API. Check the server and API_BASE_URL, then try again.';
      });
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Price Tracker')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                const Text('DEVELOPMENT STARTER'),
                const SizedBox(height: 20),

                Text(
                  'One API. Web + Android.',
                  style: Theme.of(context).textTheme.headlineLarge,
                ),
                const SizedBox(height: 16),

                const Text(
                  'Accounts, tracked products, price history, and alerts are not implemented yet. '
                  'This screen checks the shared Express API only.',
                ),
                const SizedBox(height: 32),

                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Check the connection',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 12),

                        const Text(
                          'No database or service credentials are needed for this check.',
                        ),
                        const SizedBox(height: 24),

                        FilledButton.icon(
                          onPressed: _busy ? null : _checkConnection,
                          icon: const Icon(Icons.network_check),
                          label: Text(_busy ? 'Checking…' : 'Check API'),
                        ),
                        const SizedBox(height: 20),

                        Semantics(liveRegion: true, child: Text(_message)),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 24),

                const Text(
                  'No live retailer data or saved watchlists in this starter.',
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
