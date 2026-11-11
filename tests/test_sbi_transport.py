"""Network-accounting regressions for the existing headless SBI harness."""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sbi_harness", ROOT / "test_sbi.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class TransferAccountingTests(unittest.TestCase):
    def test_all_attempts_and_redirects_count_including_failed_partial_downloads(self):
        ledger = harness.NetworkTransferLedger()
        events = [
            ("Network.requestWillBeSent", {"requestId": "a", "request": {"url": "https://site/index"}}),
            ("Network.responseReceived", {"requestId": "a", "response": {"status": 200, "encodedDataLength": 200}}),
            ("Network.loadingFinished", {"requestId": "a", "encodedDataLength": 1200}),
            ("Network.requestWillBeSent", {"requestId": "b", "request": {"url": "https://site/ref"}}),
            ("Network.dataReceived", {"requestId": "b", "encodedDataLength": 300}),
            ("Network.loadingFailed", {"requestId": "b", "errorText": "connection reset"}),
            ("Network.requestWillBeSent", {"requestId": "c", "request": {"url": "https://site/ref"}}),
            ("Network.requestWillBeSent", {"requestId": "c", "request": {"url": "https://cdn/ref"},
                "redirectResponse": {"status": 302, "encodedDataLength": 150}}),
            ("Network.responseReceived", {"requestId": "c", "response": {"status": 200, "fromDiskCache": False}}),
            ("Network.loadingFinished", {"requestId": "c", "encodedDataLength": 800}),
            ("Network.requestWillBeSent", {"requestId": "d", "request": {"url": "blob:local-input"}}),
            ("Network.loadingFinished", {"requestId": "d", "encodedDataLength": 9000}),
        ]
        for method, params in events:
            ledger.consume({"method": method, "params": params})
        report = ledger.snapshot()
        self.assertEqual(report["transferredBytes"], 2450)
        self.assertEqual(len(report["requests"]), 4)
        self.assertEqual(report["failedRequests"], 1)
        self.assertFalse(report["complete"], "failed requests with no final byte count leave a gap")
        self.assertEqual(report["pendingRequests"], 0)

    def test_transfer_measurement_requires_a_declared_cache_mode_and_preserves_matcher_selection(self):
        with patch('sys.argv', ['test_sbi.py', '--matcher', 'aligned', '--transfer-report', 'report.json', '--benchmark', 'cold']):
            args = harness.parse_args()
        self.assertEqual(args.matcher, 'aligned')
        self.assertEqual(args.transfer_report, 'report.json')
        with patch('sys.argv', ['test_sbi.py', '--transfer-report', 'report.json']):
            with self.assertRaises(SystemExit):
                harness.parse_args()

    def test_pending_requests_are_not_reported_as_zero_byte_success(self):
        ledger = harness.NetworkTransferLedger()
        ledger.consume({"method": "Network.requestWillBeSent", "params": {
            "requestId": "pending", "request": {"url": "https://cdn/image.png"}}})
        report = ledger.snapshot()
        self.assertFalse(report["complete"])
        self.assertEqual(report["pendingRequests"], 1)
        ledger.consume({"method": "Network.loadingFinished", "params": {
            "requestId": "pending", "encodedDataLength": 123}})
        self.assertTrue(ledger.snapshot()["complete"])
        self.assertEqual(ledger.snapshot()["transferredBytes"], 123)
        ledger.reset()
        self.assertEqual(ledger.snapshot()["requests"], [])


if __name__ == "__main__":
    unittest.main()
