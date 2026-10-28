import 'package:flutter/material.dart';

import 'api.dart';
import 'app_scope.dart';
import 'client/http_tracker_repository.dart';
import 'client/mobile_api.dart';
import 'client/session_controller.dart';
import 'live_account.dart';
import 'request_feedback.dart';
import 'screens.dart';

class LiveSessionHost extends StatefulWidget {
  const LiveSessionHost({
    super.key,
    required this.session,
    required this.api,
    this.healthApi,
    this.accountStatusBuilder,
  });
  final SessionController session;
  final MobileApi api;
  final HealthApi? healthApi;
  final AccountStatusBuilder? accountStatusBuilder;
  @override
  State<LiveSessionHost> createState() => _LiveSessionHostState();
}

class _LiveSessionHostState extends State<LiveSessionHost>
    with RequestCooldown, WidgetsBindingObserver {
  bool _restoring = true, _signingOut = false;
  Object? _restoreError;
  String? _notice, _sessionId;
  HttpTrackerRepository? _repository;
  int _epoch = 0;
  @override
  void initState() {
    super.initState();
    widget.session.addListener(_changed);
    WidgetsBinding.instance.addObserver(this);
    _restore();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed ||
        _restoring ||
        widget.session.user == null) {
      return;
    }
    widget.session.checkSession().catchError((Object error) {
      if (!mounted) return;
      setState(() => _notice = requestMessage(error));
      if (widget.session.user != null) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(requestMessage(error))));
      }
    });
  }

  void _changed() {
    if (!mounted) return;
    final id = widget.session.sessionId;
    if (id != _sessionId) {
      _repository?.dispose();
      _repository = id == null ? null : HttpTrackerRepository(widget.api);
      if (id == null && !_signingOut) {
        _notice = 'Your session ended. Please sign in again.';
      }
      _sessionId = id;
      _epoch++;
    }
    if (widget.session.expiryFailure != null) {
      _notice = requestMessage(widget.session.expiryFailure!);
    }
    setState(() {});
  }

  Future<void> _restore() async {
    setState(() {
      _restoring = true;
      _restoreError = null;
    });
    try {
      await widget.session.restore();
    } catch (error) {
      if (!mounted) return;
      if (error is ApiFailure &&
          (error.status == 401 ||
              ['SESSION_EXPIRED', 'INVALID_SESSION'].contains(error.code))) {
        _notice = requestMessage(error);
      } else {
        _restoreError = error;
        coolDown(error);
      }
    } finally {
      if (mounted) setState(() => _restoring = false);
    }
  }

  Future<void> _signOut() async {
    setState(() => _signingOut = true);
    try {
      await widget.session.logout();
      _notice = widget.session.revocationUnconfirmed
          ? 'Local credentials cleared. Earlier server revocation was not confirmed; that session may remain valid until expiry.'
          : 'Signed out.';
    } catch (error) {
      _notice = widget.session.revocationUnconfirmed
          ? '${requestMessage(error)} Signed out locally; server revocation was not confirmed. The old session may remain valid until expiry.'
          : requestMessage(error);
    } finally {
      if (mounted) {
        setState(() {
          _restoreError = null;
          _restoring = false;
          _signingOut = false;
        });
      }
    }
  }

  @override
  void dispose() {
    widget.session.removeListener(_changed);
    WidgetsBinding.instance.removeObserver(this);
    _repository?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_restoring) {
      return const TrackerAppScope(
        sample: false,
        child: SamplePage(
          title: 'Restoring session',
          child: Center(child: CircularProgressIndicator()),
        ),
      );
    }
    if (_restoreError != null) {
      return TrackerAppScope(
        sample: false,
        child: SamplePage(
          title: 'Session unavailable',
          child: PageList(
            children: [
              const Text(
                'Your saved session could not be checked. You have not been signed out. No sample data was loaded.',
              ),
              ErrorMessage(requestMessage(_restoreError!)),
              FilledButton(
                onPressed: retrySeconds > 0 ? null : _restore,
                child: Text(
                  retrySeconds > 0
                      ? 'Retry in $retrySeconds seconds'
                      : 'Retry session',
                ),
              ),
              TextButton(
                onPressed: _signingOut ? null : _signOut,
                child: const Text('Sign out instead'),
              ),
            ],
          ),
        ),
      );
    }
    Widget account(BuildContext context) => LiveAccountScreen(
      session: widget.session,
      signOut: _signOut,
      statusBuilder: widget.accountStatusBuilder,
    );
    return TrackerAppScope(
      sample: false,
      accountBuilder: account,
      child: widget.session.user == null
          ? LiveAuthScreen(
              api: widget.api,
              session: widget.session,
              notice: _notice,
              blocked: _signingOut,
              cleanup: _signOut,
            )
          : Navigator(
              key: ValueKey(_epoch),
              onGenerateRoute: (_) => MaterialPageRoute<void>(
                builder: (_) => WatchlistScreen(
                  repository: _repository!,
                  api: widget.healthApi,
                ),
              ),
            ),
    );
  }
}
