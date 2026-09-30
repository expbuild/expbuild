"""Read-only fixture transport recovery must not weaken TLS or HTTP assertions."""
import http.client
import ssl
import unittest
from unittest.mock import Mock, patch
from gateway_fixture import GatewayFixture

class RecoveryTest(unittest.TestCase):
    def probe(self, errors, method='GET', trusted=True, exit_code=None):
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
                return Mock(status=401, read=lambda: b'', getheaders=lambda: [])
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
        result, calls, _ = self.probe([])
        self.assertEqual(result[0], 401)
        self.assertEqual(len(calls), 1)

if __name__ == '__main__':
    unittest.main()
