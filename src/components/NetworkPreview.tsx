export default function NetworkPreview() {
  return (
    <div className="network-preview" role="img" aria-label="Illustrative synthetic account relationship network preview">
      <div className="network-grid" />
      <svg viewBox="0 0 640 230" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <line x1="94" y1="74" x2="211" y2="108" className="network-line" />
        <line x1="211" y1="108" x2="318" y2="79" className="network-line highlight" />
        <line x1="318" y1="79" x2="426" y2="117" className="network-line" />
        <line x1="426" y1="117" x2="551" y2="69" className="network-line" />
        <line x1="211" y1="108" x2="265" y2="177" className="network-line" />
        <line x1="265" y1="177" x2="390" y2="167" className="network-line highlight" />
        <line x1="390" y1="167" x2="426" y2="117" className="network-line" />
        <line x1="318" y1="79" x2="390" y2="167" className="network-line" />
        <line x1="94" y1="74" x2="126" y2="162" className="network-line" />
        <line x1="126" y1="162" x2="265" y2="177" className="network-line" />
        <line x1="551" y1="69" x2="535" y2="166" className="network-line" />
        <line x1="535" y1="166" x2="390" y2="167" className="network-line" />
        <circle cx="94" cy="74" r="5" className="network-node dim" />
        <circle cx="211" cy="108" r="7" className="network-node" />
        <circle cx="318" cy="79" r="9" className="network-center" />
        <circle cx="426" cy="117" r="6" className="network-node hot" />
        <circle cx="551" cy="69" r="5" className="network-node dim" />
        <circle cx="126" cy="162" r="4" className="network-node dim" />
        <circle cx="265" cy="177" r="6" className="network-node" />
        <circle cx="390" cy="167" r="8" className="network-node hot" />
        <circle cx="535" cy="166" r="5" className="network-node dim" />
      </svg>
      <span className="network-label label-one">acct_1048</span>
      <span className="network-label label-two">acct_2911</span>
      <span className="network-label label-three">acct_8830</span>
      <span className="network-chip"><i /> Scene placeholder</span>
    </div>
  )
}