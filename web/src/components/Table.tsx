/**
 * Table styles, shared by portfolio, leaderboard, settlement and outcome tables.
 *
 *   <TableWrap>
 *     <table className={tableStyles.table}>
 *       <thead><tr><th>Position</th><th className={tableStyles.num}>Value</th></tr></thead>
 *       <tbody>
 *         <tr className={cx(tableStyles.row, won && tableStyles.rowPositive)}>
 *           <td>...</td><td className={tableStyles.num}>$12.00</td>
 *         </tr>
 *       </tbody>
 *     </table>
 *   </TableWrap>
 *
 * Classes: table, compact (denser rows), num (right-aligned tabular cell,
 * use on th and td), row (hover wash), rowLink (pointer + hover),
 * rowPositive (winner tint), rowSelected (edge tint), muted (secondary cell
 * text), strong (primary cell text), cellMain (flex cell: monogram + name).
 */
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import tableStyles from "./Table.module.css";

export { tableStyles };

export type TableWrapProps = {
  children: ReactNode;
  /** Wrap the table in a surface card with a hairline border. Default true. */
  card?: boolean;
  className?: string;
};

/** Horizontal-scroll container, so wide tables never widen the page. */
export function TableWrap({ children, card = true, className }: TableWrapProps) {
  return <div className={cx(tableStyles.wrap, card && tableStyles.card, className)}>{children}</div>;
}
