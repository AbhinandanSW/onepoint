import "@/components/Accordion/Accordion.css";
import { type CSSProperties, type ReactNode, useId, useState } from "react";

interface AccordionProps {
  defaultExpanded?: boolean;
  title: ReactNode;
  children: ReactNode;
  titleIcon?: ReactNode;
  arrowIcon?: ReactNode;
  containerStyle?: CSSProperties;
  childStyle?: CSSProperties;
  onToggle?: (expanded: boolean) => void;
}

const Accordion = ({
  defaultExpanded = false,
  title,
  children,
  titleIcon,
  arrowIcon,
  containerStyle,
  childStyle,
  onToggle,
}: AccordionProps) => {
  const panelId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);

  const handleExpand = () => {
    const newValue = !expanded
    setExpanded(newValue);
    onToggle?.(newValue);
  };

  return (
    <div className="accordion_container" >
      <button
        type="button"
        className="accordion_title_container"
        style={containerStyle}
        onClick={handleExpand}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span className="accordion_title">
          {titleIcon}
          {title}
        </span>
        <span className="accordion_expand_icon">
          {arrowIcon}
        </span>
      </button>
      <div
        className={`accordion_child_container ${expanded ? "accordion_expanded" : ""}`}
        style={childStyle}
        id={panelId}
        role="region"
      >
        {children}
      </div>
    </div>
  );
};

export default Accordion;
