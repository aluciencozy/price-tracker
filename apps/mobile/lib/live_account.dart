import 'package:flutter/material.dart';

import 'client/mobile_api.dart';
import 'client/session_controller.dart';
import 'request_feedback.dart';
import 'screens.dart';

typedef AccountStatusBuilder = Widget Function(
  BuildContext context,
  SessionController session,
);
typedef SessionIntegrationBuilder = Widget Function(
  BuildContext context,
  SessionController session,
  Widget child,
);

class LiveAccountScreen extends StatelessWidget {
  const LiveAccountScreen({
    super.key,
    required this.session,
    required this.signOut,
    this.statusBuilder,
  });
  final SessionController session;
  final Future<void> Function() signOut;
  final AccountStatusBuilder? statusBuilder;
  @override
  Widget build(BuildContext context) => SamplePage(
    title: 'Account and settings',
    child: PageList(
      children: [
        Text(
          session.user?.name ?? 'Your account',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        Text(session.user?.email ?? ''),
        const Text(
          'Verified account • Seven-day session. Password reset revokes all sessions.',
        ),
        FilledButton(onPressed: signOut, child: const Text('Sign out')),
        const Divider(),
        if (statusBuilder != null)
          statusBuilder!(context, session)
        else
          const Text(
            'Android push is not connected. A saved preference does not enable device delivery.',
          ),
      ],
    ),
  );
}

class LiveAuthScreen extends StatefulWidget {
  const LiveAuthScreen({
    super.key,
    required this.api,
    required this.session,
    this.notice,
    this.blocked = false,
    this.cleanup,
  });
  final MobileApi api;
  final SessionController session;
  final String? notice;
  final bool blocked;
  final Future<void> Function()? cleanup;
  @override
  State<LiveAuthScreen> createState() => _LiveAuthScreenState();
}

class _LiveAuthScreenState extends State<LiveAuthScreen> with RequestCooldown {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController(),
      _password = TextEditingController(),
      _name = TextEditingController();
  String _mode = 'Sign in';
  bool _busy = false;
  String? _error, _message;
  bool get _credentials => _mode == 'Sign in' || _mode == 'Register';
  bool get _instruction => _mode == 'Verify email' || _mode == 'Reset password';
  bool get _disabled =>
      _busy ||
      widget.blocked ||
      retrySeconds > 0 ||
      widget.session.cleanupRequired;
  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
      _message = null;
    });
    try {
      switch (_mode) {
        case 'Sign in':
          await widget.session.login(_email.text.trim(), _password.text);
        case 'Register':
          await widget.api.register(
            email: _email.text.trim(),
            password: _password.text,
            name: _name.text.trim().isEmpty ? null : _name.text.trim(),
          );
        case 'Resend verification':
          await widget.api.resendVerification(_email.text.trim());
        case 'Forgot password':
          await widget.api.forgotPassword(_email.text.trim());
      }
      if (!mounted) return;
      _password.clear();
      setState(
        () => _message = 'If eligible, you will receive an email with next steps. Open the email link in your browser, complete the action there, then return here and sign in.',
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = requestMessage(error);
        coolDown(error);
      });
      if (error is ApiFailure && error.code == 'EMAIL_UNVERIFIED') {
        setState(
          () => _message = 'Verify your email in the browser before signing in. Use Resend verification if you need a new link.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: SamplePage(
      title: 'Your account',
      child: Form(
        key: _form,
        child: PageList(
          children: [
            Text(_mode, style: Theme.of(context).textTheme.headlineSmall),
            const Text(
              'Live API mode. Use your verified Price Tracker account. No sample data is uploaded.',
            ),
            if (widget.notice != null) ErrorMessage(widget.notice!),
            if (widget.session.cleanupRequired && widget.cleanup != null)
              FilledButton(
                onPressed: widget.blocked ? null : widget.cleanup,
                child: const Text('Retry clearing local credentials'),
              ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final mode in [
                  'Sign in',
                  'Register',
                  'Resend verification',
                  'Forgot password',
                  'Verify email',
                  'Reset password',
                ])
                  ChoiceChip(
                    label: Text(mode),
                    selected: _mode == mode,
                    onSelected: _disabled
                        ? null
                        : (_) => setState(() {
                            _mode = mode;
                            _error = null;
                            _message = null;
                            _password.clear();
                            _form.currentState?.reset();
                          }),
                  ),
              ],
            ),
            if (_instruction) ...[
              Text(
                _mode == 'Verify email'
                    ? 'Open the verification link from your email in a browser. Explicitly confirm verification there, return to this app and sign in. Request a new link with Resend verification if it expired.'
                    : 'Open the password-reset link from your email in a browser. Choose a new password there, return to this app and sign in. Request a new link with Forgot password if it expired.',
              ),
              const Text(
                'No app deep link, automatic token consumption, or automatic sign-in is used.',
              ),
            ] else ...[
              TextFormField(
                controller: _email,
                enabled: !_disabled,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.email],
                decoration: const InputDecoration(labelText: 'Email'),
                validator: (value) =>
                    value != null &&
                        value.trim().length <= 254 &&
                        RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
                            .hasMatch(value.trim())
                    ? null
                    : 'Enter a valid email address.',
              ),
              if (_mode == 'Register')
                TextFormField(
                  controller: _name,
                  enabled: !_disabled,
                  decoration: const InputDecoration(
                    labelText: 'Name (optional)',
                  ),
                  validator: (value) => (value?.runes.length ?? 0) <= 100
                      ? null
                      : 'Use at most 100 characters.',
                ),
              if (_credentials)
                TextFormField(
                  controller: _password,
                  enabled: !_disabled,
                  obscureText: true,
                  autofillHints: [
                    _mode == 'Register'
                        ? AutofillHints.newPassword
                        : AutofillHints.password,
                  ],
                  decoration: InputDecoration(
                    labelText: 'Password',
                    helperText: _mode == 'Register'
                        ? '12–128 characters. Passwords are not trimmed.'
                        : null,
                  ),
                  validator: (value) =>
                      (value?.runes.length ?? 0) >=
                              (_mode == 'Register' ? 12 : 1) &&
                          (value?.runes.length ?? 0) <= 128
                      ? null
                      : 'Check the password length.',
                ),
              FilledButton(
                onPressed: _disabled ? null : _submit,
                child: Text(_mode),
              ),
            ],
            if (_busy || widget.blocked) const LinearProgressIndicator(),
            if (retrySeconds > 0) Text('Try again in $retrySeconds seconds.'),
            if (_error != null) ErrorMessage(_error!),
            if (_message != null)
              Semantics(liveRegion: true, child: Text(_message!)),
          ],
        ),
      ),
    ),
  );
}
