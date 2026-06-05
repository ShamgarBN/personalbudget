import AccountLedger from "./AccountLedger";

export default function AccountBank() {
  return (
    <AccountLedger
      accountKind="checking"
      title="Bank Account"
      halfMonthCollapse
      showPinnedCcPayment
      showCcStartingBalance
    />
  );
}
