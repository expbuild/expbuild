"""Read-only fixture transport recovery must not weaken TLS or HTTP assertions."""
import http.client
import io
import json
from contextlib import redirect_stdout
import ssl
import unittest
from unittest.mock import Mock, patch
from gateway_fixture import GatewayFixture

class RecoveryTest(unittest.TestCase):
    def probe(self, errors, method='GET', trusted=True, exit_code=None, response_status=401):
        fixture = GatewayFixture(None, None, '/tmp', 'unused', 'unused')
        fixture.process = Mock()
        fixture.process.poll.return_value = exit_code
        fixture.close = Mock()
        fixture.forward = Mock()
        calls = []
        class Connection:
            def __init__(self, *args, **kwargs): pass
            def request(self, *args, **kwargs): calls.append(1)
            def getresponse(self):
                if errors: raise errors.pop(0)
                return Mock(status=response_status, read=lambda: b'', getheaders=lambda: [])
            def close(self): pass
        with patch('gateway_fixture.http.client.HTTPConnection', Connection), patch('gateway_fixture.ssl.create_default_context'), patch('gateway_fixture.time.sleep'):
            try:
                result = fixture.request('fixture', method=method, trusted=trusted)
            except Exception as error:
                result = error
        return result, calls, fixture

    def test_recovers_only_a_confirmed_exited_forwarder(self):
        for exit_code in (None, 1):
            result, calls, fixture = self.probe([http.client.RemoteDisconnected(), ConnectionRefusedError()], exit_code=exit_code)
            self.assertEqual(result[0], 401)
            self.assertEqual(len(calls), 3)
            self.assertEqual(fixture.forward.call_count, 0 if exit_code is None else 2)

    def test_bounds_retries(self):
        result, calls, _ = self.probe([ConnectionResetError() for _ in range(4)])
        self.assertIsInstance(result, ConnectionResetError)
        self.assertEqual(len(calls), 3)

    def test_never_retries_writes_tls_verification_or_http_status(self):
        for method, trusted, error in [('PUT', True, http.client.RemoteDisconnected()), ('GET', False, http.client.RemoteDisconnected()), ('GET', True, ssl.SSLCertVerificationError())]:
            result, calls, fixture = self.probe([error], method, trusted, 1)
            self.assertIs(result, error)
            self.assertEqual(len(calls), 1)
            fixture.forward.assert_not_called()
        for code in (401, 403, 404, 500, 503):
            result, calls, _ = self.probe([], response_status=code)
            self.assertEqual(result[0], code)
            self.assertEqual(len(calls), 1)

class ProxyDiagnosticsTest(unittest.TestCase):
    def test_only_transport_fields_are_printed(self):
        fixture = GatewayFixture(Mock(), None, '/tmp', 'unused', 'unused')
        fixture.kubectl.side_effect = [json.dumps({'items': [{'metadata': {'name': 'proxy'}, 'status': {'phase': 'Running', 'containerStatuses': [{'name': 'envoy', 'ready': True, 'restartCount': 0, 'secret': 'not-for-output'}]}}]}),
            json.dumps({'response_code': 0, 'response_flags': 'DPE', 'response_code_details': 'http1.codec_error', 'authorization': 'private-token', 'path': '/private-path', 'protocol': 'HTTP/1.1'}) + '\nraw-private-token\n[]']
        output = io.StringIO()
        with redirect_stdout(output): fixture.diagnose_proxy()
        text = output.getvalue()
        self.assertIn('http1.codec_error', text)
        self.assertIn('DPE', text)
        self.assertIn('restartCount', text)
        for secret in ('private-token', 'private-path', 'not-for-output'):
            self.assertNotIn(secret, text)
        self.assertIn('--tail=100', fixture.kubectl.call_args.args)

    def test_diagnostic_failure_does_not_replace_original_failure(self):
        fixture = GatewayFixture(Mock(side_effect=RuntimeError('private-error-context')), None, '/tmp', 'unused', 'unused')
        output = io.StringIO()
        with redirect_stdout(output): fixture.diagnose_proxy()
        self.assertIn('RuntimeError', output.getvalue())
        self.assertNotIn('private-error-context', output.getvalue())

class ClientDiagnosticsTest(unittest.TestCase):
    def test_failed_write_reports_stage_and_transport_without_request_data(self):
        for stage, error in [('tcp_connect', ConnectionRefusedError('private-error')),
                             ('tls_handshake', ssl.SSLCertVerificationError('private-error')),
                             ('send_request', ConnectionResetError('private-error')),
                             ('read_status', http.client.RemoteDisconnected('private-error')),
                             ('read_body', ConnectionResetError('private-error'))]:
            with self.subTest(stage=stage):
                fixture = GatewayFixture(None, None, '/tmp', 'unused', 'unused')
                fixture.port = 12345
                fixture.process = Mock(pid=321)
                fixture.process.poll.side_effect = [None, 1]
                fixture.forward = Mock()
                requests, closes = [], []
                tls_socket = Mock()
                tls_socket.version.return_value = 'TLSv1.3'
                tls_socket.selected_alpn_protocol.return_value = 'http/1.1'
                context = Mock()
                context.wrap_socket.return_value = tls_socket
                if stage == 'tls_handshake': context.wrap_socket.side_effect = error
                response = Mock(status=200, getheaders=lambda: [])
                response.read.side_effect = error if stage == 'read_body' else None
                class Connection:
                    def __init__(self, *args, **kwargs): pass
                    def request(self, *args, **kwargs):
                        requests.append(1)
                        self.connect()
                        if stage == 'send_request': raise error
                    def getresponse(self):
                        if stage == 'read_status': raise error
                        return response
                    def close(self): closes.append(1)
                output = io.StringIO()
                with patch('gateway_fixture.http.client.HTTPConnection', Connection), \
                     patch('gateway_fixture.ssl.create_default_context', return_value=context), \
                     patch('gateway_fixture.socket.create_connection', side_effect=error if stage == 'tcp_connect' else None), \
                     redirect_stdout(output):
                    with self.assertRaises(type(error)) as raised:
                        fixture.request('private-host', '/private-path', 'PUT', b'private-body', {'Authorization': 'private-token'})
                self.assertIs(raised.exception, error)
                self.assertEqual(requests, [1])
                self.assertEqual(closes, [1])
                fixture.forward.assert_not_called()
                text = output.getvalue()
                for secret in ('private-host', 'private-path', 'private-body', 'private-token', 'private-error'):
                    self.assertNotIn(secret, text)
                event = json.loads(text.split('Gateway client transport failure: ', 1)[1])
                self.assertEqual(event['stage'], stage)
                self.assertEqual(event['attempt'], 1)
                self.assertEqual(event['forwarder_before'], {'pid': 321, 'returncode': None})
                self.assertEqual(event['forwarder_after'], {'pid': 321, 'returncode': 1})
                self.assertEqual(event['local_port'], 12345)
                if stage not in ('tcp_connect', 'tls_handshake'):
                    self.assertEqual((event['tls_version'], event['alpn']), ('TLSv1.3', 'http/1.1'))

    def test_unavailable_diagnostics_preserve_the_original_failure(self):
        fixture = GatewayFixture(None, None, '/tmp', 'unused', 'unused')
        fixture.process = Mock()
        fixture.process.poll.side_effect = OSError('private-process-error')
        self.assertEqual(fixture.forwarder_state()['state'], 'unavailable')
        error = http.client.RemoteDisconnected('original')
        with patch('gateway_fixture.print', side_effect=OSError('private-output-error')):
            result, calls, _ = RecoveryTest().probe([error], method='PUT')
        self.assertIs(result, error)
        self.assertEqual(calls, [1])

    def test_extra_event_fields_and_exception_text_are_not_logged(self):
        fixture = GatewayFixture(None, None, '/tmp', 'unused', 'unused')
        output = io.StringIO()
        with redirect_stdout(output):
            fixture.diagnose_request_failure({'stage': 'read_status', 'headers': 'private-header',
                                              'path': 'private-path', 'body': 'private-body'},
                                             ConnectionResetError('private-error'), 0)
        self.assertIn('read_status', output.getvalue())
        self.assertNotIn('private-', output.getvalue())

if __name__ == '__main__':
    unittest.main()
