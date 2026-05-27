import React from "react";

const Link = ({ href, children, ...props }: any) => (
  <a href={String(href)} {...props}>
    {children}
  </a>
);

export default Link;
